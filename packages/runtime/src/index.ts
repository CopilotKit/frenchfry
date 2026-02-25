export const RUNTIME_PACKAGE_NAME = "@frenchfryai/runtime";

export type RuntimePackageName = typeof RUNTIME_PACKAGE_NAME;

export {
  buildOpenAIHeaders,
  buildOpenAIRealtimeUrl,
  registerRealtimeProxy,
  type ClientSocket,
  type OpenAIServerEvent,
  type RealtimeProxyRegistration,
  type RuntimeNodeWebSocketAdapter,
  type RuntimeOpenAIOptions,
  type RuntimeRealtimeProxyOptions,
  type UpstreamSocket
} from "./runtime-proxy";

export {
  type JsonObject,
  type JsonPrimitive,
  type JsonValue,
  isRuntimeToolSuccessEvent,
  parseRuntimeClientProtocolEvent,
  serializeToolSuccessEnvelope,
  type OpenAIClientEvent,
  type RuntimeClientProtocolEvent,
  type RuntimeToolSuccessEnvelope,
  type RuntimeToolSuccessEvent
} from "./protocol";
