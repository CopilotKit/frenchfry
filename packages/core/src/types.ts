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
 * Represents server events consumed by the core runtime client.
 */
export type CoreServerEvent =
  | ErrorEvent
  | FunctionCallArgumentsDeltaEvent
  | FunctionCallArgumentsDoneEvent
  | UnknownServerEvent;

/**
 * Represents a structured tool success payload sent from core to runtime.
 */
export type RuntimeToolSuccessEnvelope = {
  data?: JsonValue;
  meta?: JsonValue;
  ok: true;
};

/**
 * Represents a convenience client event for reporting successful tool execution.
 */
export type RuntimeToolSuccessEvent = {
  callId: string;
  output: RuntimeToolSuccessEnvelope;
  type: "runtime.tool.success";
};

/**
 * Represents a generic pass-through client event envelope.
 */
export type OpenAIClientEvent = {
  type: string;
} & Record<string, unknown>;

/**
 * Represents client events accepted by the runtime proxy connection.
 */
export type CoreClientEvent = OpenAIClientEvent | RuntimeToolSuccessEvent;

/**
 * Represents input for reporting successful tool execution.
 */
export type ToolCallSuccessInput = {
  callId: string;
  output: RuntimeToolSuccessEnvelope;
};

/**
 * Represents a discovered function call stream with call metadata and chunk observable.
 */
export type ToolCallStart = {
  argumentChunks$: Observable<string>;
  callId: string;
  itemId: string;
  reportSuccess: (output: RuntimeToolSuccessEnvelope) => void;
  responseId: string;
};

/**
 * Represents options for establishing a runtime websocket client connection.
 */
export type CreateRealtimeClientOptions = {
  socketFactory?: (url: string) => WebSocketLike;
  url: string;
};

/**
 * Represents the subset of WebSocket behavior required by the core runtime client.
 */
export type WebSocketLike = {
  close: (code?: number, reason?: string) => void;
  onclose:
    | ((event: {
        code: number | undefined;
        reason: string | undefined;
      }) => void)
    | null;
  onerror: ((event: unknown) => void) | null;
  onmessage: ((event: { data: string }) => void) | null;
  onopen: (() => void) | null;
  readyState: number;
  send: (payload: string) => void;
};

/**
 * Represents the public API of the core runtime websocket client.
 */
export type RealtimeClient = {
  connect: () => void;
  disconnect: () => void;
  events$: Observable<CoreServerEvent>;
  reportToolSuccess: (input: ToolCallSuccessInput) => void;
  send: (event: CoreClientEvent) => void;
  toolCallStarts$: Observable<ToolCallStart>;
};
