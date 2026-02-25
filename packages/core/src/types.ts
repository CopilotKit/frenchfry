/* v8 ignore file */
import type { Observable } from "rxjs";

/**
 * Represents a JSON primitive value.
 */
export type JsonPrimitive = boolean | null | number | string;

/**
 * Represents any JSON-serializable value.
 */
export type JsonValue =
  | JsonPrimitive
  | JsonValue[]
  | { [key: string]: JsonValue };

/**
 * Represents an unknown pass-through server event with at least a `type` field.
 */
export type UnknownServerEvent = {
  type: string;
} & Record<string, unknown>;

/**
 * Represents OpenAI Realtime streaming function call argument delta events.
 */
export type FunctionCallArgumentsDeltaEvent = {
  call_id: string;
  delta: string;
  event_id?: string;
  item_id: string;
  output_index: number;
  response_id: string;
  type: "response.function_call_arguments.delta";
};

/**
 * Represents OpenAI Realtime function call argument completion events.
 */
export type FunctionCallArgumentsDoneEvent = {
  arguments: string;
  call_id: string;
  event_id?: string;
  item_id: string;
  name?: string;
  output_index: number;
  response_id: string;
  type: "response.function_call_arguments.done";
};

/**
 * Represents OpenAI or runtime error events.
 */
export type ErrorEvent = {
  error: {
    code?: string;
    message: string;
    param?: string;
    type: string;
  };
  event_id?: string;
  type: "error";
};

/**
 * Represents server events consumed by the core realtime client.
 */
export type CoreServerEvent =
  | ErrorEvent
  | FunctionCallArgumentsDeltaEvent
  | FunctionCallArgumentsDoneEvent
  | UnknownServerEvent;

/**
 * Represents a generic pass-through client event envelope.
 */
export type OpenAIClientEvent = {
  type: string;
} & Record<string, unknown>;

/**
 * Represents client events accepted by the realtime data channel.
 */
export type CoreClientEvent = OpenAIClientEvent;

/**
 * Represents a discovered function call stream with call metadata and chunk observable.
 */
export type ToolCallStart = {
  argumentChunks$: Observable<string>;
  callId: string;
  itemId: string;
  responseId: string;
};

/**
 * Represents the minimum data channel surface required by the core realtime client.
 */
export type RealtimeDataChannelLike = {
  close: () => void;
  onclose: (() => void) | null;
  onerror: ((event: unknown) => void) | null;
  onmessage: ((event: { data: string }) => void) | null;
  onopen: (() => void) | null;
  readyState: "closed" | "closing" | "connecting" | "open";
  send: (payload: string) => void;
};

/**
 * Represents a minimal local media track used for microphone toggling.
 */
export type RealtimeMediaStreamTrackLike = {
  enabled: boolean;
  stop: () => void;
};

/**
 * Represents a minimal local media stream used for microphone capture.
 */
export type RealtimeMediaStreamLike = {
  getAudioTracks: () => RealtimeMediaStreamTrackLike[];
  getTracks: () => RealtimeMediaStreamTrackLike[];
};

/**
 * Represents a minimal remote track event used for remote audio streams.
 */
export type RealtimeTrackEventLike = {
  streams: readonly MediaStream[];
};

/**
 * Represents the minimum peer connection surface required by the core realtime client.
 */
export type RealtimePeerConnectionLike = {
  addTrack: (
    track: RealtimeMediaStreamTrackLike,
    ...streams: RealtimeMediaStreamLike[]
  ) => unknown;
  close: () => void;
  connectionState:
    | "closed"
    | "connected"
    | "connecting"
    | "disconnected"
    | "failed"
    | "new";
  createDataChannel: (label: string) => RealtimeDataChannelLike;
  createOffer: () => Promise<RTCSessionDescriptionInit>;
  onconnectionstatechange: (() => void) | null;
  ontrack: ((event: RealtimeTrackEventLike) => void) | null;
  setLocalDescription: (
    description: RTCSessionDescriptionInit
  ) => Promise<void>;
  setRemoteDescription: (
    description: RTCSessionDescriptionInit
  ) => Promise<void>;
};

/**
 * Represents realtime session configuration sent to OpenAI call setup.
 */
export type RealtimeSessionConfig = {
  model: string;
  type: "realtime";
} & Record<string, unknown>;

/**
 * Represents options for establishing a runtime realtime client connection.
 */
export type CreateRealtimeClientOptions = {
  dataChannelLabel?: string;
  fetchImpl?: typeof fetch;
  getUserMedia?: (
    constraints: MediaStreamConstraints
  ) => Promise<RealtimeMediaStreamLike>;
  peerConnectionFactory?: () => RealtimePeerConnectionLike;
  session: RealtimeSessionConfig;
  sessionEndpoint: string;
};

/**
 * Represents the public API of the core runtime realtime client.
 */
export type RealtimeClient = {
  connect: () => Promise<void>;
  disconnect: () => void;
  events$: Observable<CoreServerEvent>;
  remoteAudioStream$: Observable<MediaStream>;
  send: (event: CoreClientEvent) => void;
  setMicrophoneEnabled: (enabled: boolean) => Promise<void>;
  toolCallStarts$: Observable<ToolCallStart>;
};
