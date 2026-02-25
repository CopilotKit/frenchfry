export const RUNTIME_PACKAGE_NAME = "@frenchfryai/runtime";

export type RuntimePackageName = typeof RUNTIME_PACKAGE_NAME;

export {
  registerRealtimeSessionRoute,
  type RealtimeSessionRegistration,
  type RuntimeOpenAIOptions,
  type RuntimeRealtimeSessionOptions
} from "./realtime-session";

export {
  type JsonObject,
  type JsonPrimitive,
  type JsonValue,
  parseRuntimeClientProtocolEvent,
  type OpenAIClientEvent,
  type RuntimeClientProtocolEvent
} from "./protocol";
