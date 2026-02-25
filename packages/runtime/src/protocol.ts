import { z } from "zod";

/**
 * Represents a JSON primitive value.
 */
export type JsonPrimitive = boolean | null | number | string;

/**
 * Represents any JSON value.
 */
export type JsonValue =
  | JsonPrimitive
  | JsonValue[]
  | { [key: string]: JsonValue };

/**
 * Represents a generic JSON object with unknown keys.
 */
export type JsonObject = Record<string, unknown>;

const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.boolean(),
    z.null(),
    z.number(),
    z.string(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema)
  ])
);

const openAIClientEventSchema = z
  .object({
    type: z.string().min(1)
  })
  .catchall(jsonValueSchema);

const runtimeToolSuccessEnvelopeSchema = z.object({
  data: jsonValueSchema.optional(),
  meta: jsonValueSchema.optional(),
  ok: z.literal(true)
});

const runtimeToolSuccessEventSchema = z.object({
  callId: z.string().min(1),
  output: runtimeToolSuccessEnvelopeSchema,
  type: z.literal("runtime.tool.success")
});

/**
 * Represents a runtime-side tool success envelope.
 */
export type RuntimeToolSuccessEnvelope = z.infer<
  typeof runtimeToolSuccessEnvelopeSchema
>;

/**
 * Represents a runtime convenience event for reporting successful tool execution.
 */
export type RuntimeToolSuccessEvent = z.infer<
  typeof runtimeToolSuccessEventSchema
>;

/**
 * Represents a pass-through client event compatible with OpenAI Realtime API.
 */
export type OpenAIClientEvent = z.infer<typeof openAIClientEventSchema>;

/**
 * Represents events accepted by runtime from browser clients.
 */
export type RuntimeClientProtocolEvent =
  | OpenAIClientEvent
  | RuntimeToolSuccessEvent;

/**
 * Validates and parses an inbound browser->runtime event payload.
 *
 * @param rawEvent Raw parsed JSON payload from client transport.
 * @returns Validated runtime protocol event.
 */
export const parseRuntimeClientProtocolEvent = (
  rawEvent: unknown
): RuntimeClientProtocolEvent => {
  const runtimeResult = runtimeToolSuccessEventSchema.safeParse(rawEvent);

  if (runtimeResult.success) {
    return runtimeResult.data;
  }

  const openAIResult = openAIClientEventSchema.safeParse(rawEvent);

  if (!openAIResult.success) {
    throw new Error("Client event is not a valid runtime protocol payload.");
  }

  return openAIResult.data;
};

/**
 * Creates a JSON string suitable for the OpenAI `function_call_output` `output` field.
 *
 * @param envelope Structured tool success envelope.
 * @returns JSON string value sent to OpenAI.
 */
export const serializeToolSuccessEnvelope = (
  envelope: RuntimeToolSuccessEnvelope
): string => {
  return JSON.stringify(envelope);
};

/**
 * Type guard for runtime tool success events.
 *
 * @param event Parsed protocol event.
 * @returns `true` when event is the runtime tool success event.
 */
export const isRuntimeToolSuccessEvent = (
  event: RuntimeClientProtocolEvent
): event is RuntimeToolSuccessEvent => {
  return event.type === "runtime.tool.success";
};
