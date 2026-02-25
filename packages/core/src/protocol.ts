import { z } from "zod";

import type {
  CoreClientEvent,
  CoreServerEvent,
  ErrorEvent,
  FunctionCallArgumentsDeltaEvent,
  FunctionCallArgumentsDoneEvent,
  UnknownServerEvent
} from "./types";

const jsonValueSchema: z.ZodType<unknown> = z.lazy(() =>
  z.union([
    z.boolean(),
    z.null(),
    z.number(),
    z.string(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema)
  ])
);

const errorEventSchema = z.object({
  error: z.object({
    code: z.string().optional(),
    message: z.string(),
    param: z.string().optional(),
    type: z.string()
  }),
  event_id: z.string().optional(),
  type: z.literal("error")
});

const functionCallArgumentsDeltaEventSchema = z.object({
  call_id: z.string(),
  delta: z.string(),
  event_id: z.string().optional(),
  item_id: z.string().optional(),
  output_index: z.number().optional(),
  response_id: z.string().optional(),
  type: z.literal("response.function_call_arguments.delta")
});

const functionCallArgumentsDoneEventSchema = z.object({
  arguments: z.string(),
  call_id: z.string(),
  event_id: z.string().optional(),
  item_id: z.string().optional(),
  name: z.string().optional(),
  output_index: z.number().optional(),
  response_id: z.string().optional(),
  type: z.literal("response.function_call_arguments.done")
});

const outputItemDoneFunctionCallEventSchema = z.object({
  item: z
    .object({
      arguments: z.string(),
      call_id: z.string(),
      id: z.string().optional(),
      name: z.string().optional(),
      type: z.literal("function_call")
    })
    .passthrough(),
  output_index: z.number().optional(),
  response_id: z.string().optional(),
  type: z.literal("response.output_item.done")
});

const unknownServerEventSchema = z
  .object({
    type: z.string().min(1)
  })
  .catchall(z.unknown());

const clientPassThroughEventSchema = z
  .object({
    type: z.string().min(1)
  })
  .catchall(jsonValueSchema);

/**
 * Parses an unknown JSON value into a typed server event.
 *
 * @param rawEvent Raw parsed JSON payload.
 * @returns Parsed server event.
 */
export const parseCoreServerEvent = (rawEvent: unknown): CoreServerEvent => {
  const deltaResult = functionCallArgumentsDeltaEventSchema.safeParse(rawEvent);

  if (deltaResult.success) {
    return deltaResult.data;
  }

  const doneResult = functionCallArgumentsDoneEventSchema.safeParse(rawEvent);

  if (doneResult.success) {
    return doneResult.data;
  }

  const outputItemDoneResult =
    outputItemDoneFunctionCallEventSchema.safeParse(rawEvent);

  if (outputItemDoneResult.success) {
    return {
      arguments: outputItemDoneResult.data.item.arguments,
      call_id: outputItemDoneResult.data.item.call_id,
      ...(outputItemDoneResult.data.item.id === undefined
        ? {}
        : { item_id: outputItemDoneResult.data.item.id }),
      ...(outputItemDoneResult.data.item.name === undefined
        ? {}
        : { name: outputItemDoneResult.data.item.name }),
      ...(outputItemDoneResult.data.output_index === undefined
        ? {}
        : { output_index: outputItemDoneResult.data.output_index }),
      ...(outputItemDoneResult.data.response_id === undefined
        ? {}
        : { response_id: outputItemDoneResult.data.response_id }),
      type: "response.function_call_arguments.done"
    };
  }

  const errorResult = errorEventSchema.safeParse(rawEvent);

  if (errorResult.success) {
    return errorResult.data;
  }

  const unknownResult = unknownServerEventSchema.safeParse(rawEvent);

  if (!unknownResult.success) {
    throw new Error("Server payload is not a valid event envelope.");
  }

  return unknownResult.data;
};

/**
 * Parses and validates a client event before serialization.
 *
 * @param rawEvent Raw client event payload.
 * @returns Parsed client event.
 */
export const parseCoreClientEvent = (rawEvent: unknown): CoreClientEvent => {
  const passThroughResult = clientPassThroughEventSchema.safeParse(rawEvent);

  if (!passThroughResult.success) {
    throw new Error("Client payload is not a valid event envelope.");
  }

  return passThroughResult.data;
};

/**
 * Type guard for function-call argument delta server events.
 *
 * @param event Parsed server event.
 * @returns `true` when event is a delta event.
 */
export const isFunctionCallArgumentsDeltaEvent = (
  event: CoreServerEvent
): event is FunctionCallArgumentsDeltaEvent => {
  return event.type === "response.function_call_arguments.delta";
};

/**
 * Type guard for function-call argument completion server events.
 *
 * @param event Parsed server event.
 * @returns `true` when event is a done event.
 */
export const isFunctionCallArgumentsDoneEvent = (
  event: CoreServerEvent
): event is FunctionCallArgumentsDoneEvent => {
  return event.type === "response.function_call_arguments.done";
};

/**
 * Type guard for error events.
 *
 * @param event Parsed server event.
 * @returns `true` when event is an error event.
 */
export const isErrorEvent = (event: CoreServerEvent): event is ErrorEvent => {
  return event.type === "error";
};

/**
 * Converts parsed event into unknown server event envelope.
 *
 * @param event Server event.
 * @returns Event typed as unknown envelope.
 */
export const toUnknownServerEvent = (
  event: CoreServerEvent
): UnknownServerEvent => {
  return event;
};
