export const CORE_PACKAGE_NAME = "@frenchfryai/core";

export type CorePackageName = typeof CORE_PACKAGE_NAME;

export { createRealtimeClient } from "./client";

export {
  isErrorEvent,
  isFunctionCallArgumentsDeltaEvent,
  isFunctionCallArgumentsDoneEvent,
  isRuntimeToolSuccessEvent,
  parseCoreClientEvent,
  parseCoreServerEvent,
  toUnknownServerEvent
} from "./protocol";

export type {
  CoreClientEvent,
  CoreServerEvent,
  CreateRealtimeClientOptions,
  ErrorEvent,
  FunctionCallArgumentsDeltaEvent,
  FunctionCallArgumentsDoneEvent,
  JsonPrimitive,
  JsonValue,
  OpenAIClientEvent,
  RealtimeClient,
  RuntimeToolSuccessEnvelope,
  RuntimeToolSuccessEvent,
  ToolCallStart,
  ToolCallSuccessInput,
  UnknownServerEvent,
  WebSocketLike
} from "./types";
