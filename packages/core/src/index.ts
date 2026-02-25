export const CORE_PACKAGE_NAME = "@frenchfryai/core";

export type CorePackageName = typeof CORE_PACKAGE_NAME;

export { createRealtimeClient } from "./client";
export {
  createFunctionCallOutputEvents,
  createToolCallAccumulatorState,
  createToolRegistry,
  reduceToolCallAccumulatorState,
  runToolInvocation
} from "./tool-orchestration";

export {
  isErrorEvent,
  isFunctionCallArgumentsDeltaEvent,
  isFunctionCallArgumentsDoneEvent,
  parseCoreClientEvent,
  parseCoreServerEvent,
  toUnknownServerEvent
} from "./protocol";
export type {
  OrchestrationTool,
  ToolCallAccumulatorEntry,
  ToolCallAccumulatorState,
  ToolInvocationInput,
  ToolInvocationResult,
  ToolOutputEnvelope
} from "./tool-orchestration";

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
  RealtimeDataChannelLike,
  RealtimeMediaStreamLike,
  RealtimeMediaStreamTrackLike,
  RealtimePeerConnectionLike,
  RealtimeSessionConfig,
  RealtimeTrackEventLike,
  RealtimeTransceiverDirection,
  ToolCallStart,
  UnknownServerEvent
} from "./types";
