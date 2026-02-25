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

/**
 * Represents a pass-through client event compatible with OpenAI Realtime API.
 */
export type OpenAIClientEvent = z.infer<typeof openAIClientEventSchema>;

/**
 * Represents events accepted by runtime from browser clients.
 */
export type RuntimeClientProtocolEvent = OpenAIClientEvent;

/**
 * Validates and parses an inbound browser->runtime event payload.
 *
 * @param rawEvent Raw parsed JSON payload from client transport.
 * @returns Validated runtime protocol event.
 */
export const parseRuntimeClientProtocolEvent = (
  rawEvent: unknown
): RuntimeClientProtocolEvent => {
  const openAIResult = openAIClientEventSchema.safeParse(rawEvent);

  if (!openAIResult.success) {
    throw new Error("Client event is not a valid runtime protocol payload.");
  }

  return openAIResult.data;
};
