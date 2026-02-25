import { createNodeWebSocket } from "@hono/node-ws";
import type { Hono } from "hono";
import type { Http2SecureServer, Http2Server } from "node:http2";
import type { Server } from "node:http";
import WebSocket from "ws";
import { z } from "zod";

import {
  isRuntimeToolSuccessEvent,
  parseRuntimeClientProtocolEvent,
  serializeToolSuccessEnvelope,
  type JsonObject,
  type OpenAIClientEvent,
  type RuntimeClientProtocolEvent,
  type RuntimeToolSuccessEvent
} from "./protocol";

/**
 * Represents a parsed OpenAI server event payload.
 */
export type OpenAIServerEvent = {
  type: string;
} & Record<string, unknown>;

/**
 * Represents upstream connection options for OpenAI Realtime.
 */
export type RuntimeOpenAIOptions = {
  apiKey: string;
  baseUrl?: string;
  includeBetaHeader?: boolean;
  model?: string;
  organization?: string;
  project?: string;
};

/**
 * Represents a minimal socket used by runtime for browser client transport.
 */
export type ClientSocket = {
  close: (code?: number, reason?: string) => void;
  send: (
    payload: string | ArrayBuffer | Uint8Array<ArrayBuffer>,
    options?: { compress?: boolean }
  ) => void;
};

/**
 * Represents a minimal socket abstraction used for OpenAI upstream transport.
 */
export type UpstreamSocket = {
  close: (code?: number, reason?: string) => void;
  on: {
    (event: "close", handler: (code: number, reason: Buffer) => void): void;
    (event: "error", handler: (error: unknown) => void): void;
    (
      event: "message",
      handler: (payload: Buffer | Buffer[] | string) => void
    ): void;
    (event: "open", handler: () => void): void;
  };
  send: (payload: string) => void;
};

/**
 * Represents a minimal node websocket adapter contract required by runtime registration.
 */
export type RuntimeNodeWebSocketAdapter = {
  injectWebSocket: (server: Server | Http2SecureServer | Http2Server) => void;
  upgradeWebSocket: (
    configure: (context: unknown) => {
      onClose: (event: unknown, socket: ClientSocket) => void;
      onMessage: (
        event: {
          data: string | ArrayBufferLike | Blob;
        },
        socket: ClientSocket
      ) => void;
      onOpen: (event: unknown, socket: ClientSocket) => void;
    }
  ) => (context: unknown) => Promise<Response> | Response;
};

/**
 * Represents configuration options for runtime WebSocket proxy registration.
 */
export type RuntimeRealtimeProxyOptions = {
  autoResponseAfterToolSuccess?: boolean;
  createNodeWebSocket?: (app: Hono) => RuntimeNodeWebSocketAdapter;
  createUpstreamSocket?: (
    url: string,
    headers: Record<string, string>
  ) => UpstreamSocket;
  onLog?: (message: string, details?: Record<string, unknown>) => void;
  openai: RuntimeOpenAIOptions;
  path?: string;
};

/**
 * Represents result of registering realtime proxy routes on a Hono app.
 */
export type RealtimeProxyRegistration = {
  injectWebSocket: (server: Server | Http2SecureServer | Http2Server) => void;
  path: string;
};

type ProxyState = {
  outboundQueue: string[];
  upstreamOpen: boolean;
};

const jsonObjectSchema = z.record(z.string(), z.unknown());

const DEFAULT_MODEL = "gpt-realtime";
const DEFAULT_PATH = "/realtime/ws";

/**
 * Builds the OpenAI Realtime WebSocket URL for upstream connection.
 *
 * @param options OpenAI connection options.
 * @returns Fully-qualified WebSocket URL.
 */
export const buildOpenAIRealtimeUrl = (
  options: RuntimeOpenAIOptions
): string => {
  const baseUrl = options.baseUrl ?? "wss://api.openai.com/v1/realtime";
  const url = new URL(baseUrl);
  url.searchParams.set("model", options.model ?? DEFAULT_MODEL);
  return url.toString();
};

/**
 * Builds OpenAI upstream connection headers.
 *
 * @param options OpenAI connection options.
 * @returns Headers object for upstream WebSocket handshake.
 */
export const buildOpenAIHeaders = (
  options: RuntimeOpenAIOptions
): Record<string, string> => {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${options.apiKey}`
  };

  if (options.includeBetaHeader === true) {
    headers["OpenAI-Beta"] = "realtime=v1";
  }

  if (options.organization !== undefined) {
    headers["OpenAI-Organization"] = options.organization;
  }

  if (options.project !== undefined) {
    headers["OpenAI-Project"] = options.project;
  }

  return headers;
};

/**
 * Registers a WebSocket proxy endpoint in a Hono app for OpenAI Realtime.
 *
 * @param app Target Hono app.
 * @param options Proxy configuration options.
 * @returns Registration details including effective path and injection function.
 */
export const registerRealtimeProxy = (
  app: Hono,
  options: RuntimeRealtimeProxyOptions
): RealtimeProxyRegistration => {
  const path = options.path ?? DEFAULT_PATH;

  const nodeWebSocket =
    options.createNodeWebSocket?.(app) ??
    /* c8 ignore next */
    createNodeWebSocket({ app });

  app.get(
    path,
    nodeWebSocket.upgradeWebSocket((context: unknown) => {
      void context;
      const state: ProxyState = {
        outboundQueue: [],
        upstreamOpen: false
      };

      const upstream = openUpstreamSocket(options, state);

      return {
        onClose: (_: unknown, clientSocket: ClientSocket) => {
          upstream.close(1000, "Client closed connection");
          clientSocket.close(1000, "Proxy closed");
        },
        onMessage: (
          event: { data: string | ArrayBufferLike | Blob },
          clientSocket: ClientSocket
        ) => {
          handleClientMessage(
            event.data,
            clientSocket,
            upstream,
            state,
            options
          );
        },
        onOpen: (_: unknown, clientSocket: ClientSocket) => {
          flushQueueToUpstream(state, upstream, options);
          wireUpstreamToClient(upstream, clientSocket, options);
        }
      };
    })
  );

  return {
    injectWebSocket: nodeWebSocket.injectWebSocket,
    path
  };
};

/**
 * Opens the upstream WebSocket connection to OpenAI.
 *
 * @param options Runtime proxy options.
 * @param state Mutable per-connection state.
 * @returns Upstream WebSocket instance.
 */
const openUpstreamSocket = (
  options: RuntimeRealtimeProxyOptions,
  state: ProxyState
): UpstreamSocket => {
  const url = buildOpenAIRealtimeUrl(options.openai);
  const headers = buildOpenAIHeaders(options.openai);

  const upstream =
    options.createUpstreamSocket?.(url, headers) ??
    /* c8 ignore next */
    createDefaultUpstreamSocket(url, headers);

  // Register error handler before handshake can fail to prevent unhandled `error` events.
  upstream.on("error", (error) => {
    logInfo(options, "runtime.upstream.transport_error", {
      error: toErrorMessage(error)
    });
  });

  upstream.on("open", () => {
    state.upstreamOpen = true;
    flushQueueToUpstream(state, upstream, options);
  });

  return upstream;
};

/**
 * Creates the default upstream socket implementation backed by `ws`.
 *
 * @param url OpenAI Realtime URL.
 * @param headers Handshake headers.
 * @returns Upstream socket implementation.
 */
const createDefaultUpstreamSocket = (
  url: string,
  headers: Record<string, string>
): UpstreamSocket => {
  /* c8 ignore next 4 */
  return new WebSocket(url, {
    headers
  });
};

/**
 * Flushes queued outbound messages to OpenAI once upstream is open.
 *
 * @param state Mutable per-connection state.
 * @param upstream Upstream WebSocket connection.
 * @param options Runtime options for logging.
 */
const flushQueueToUpstream = (
  state: ProxyState,
  upstream: UpstreamSocket,
  options: RuntimeRealtimeProxyOptions
): void => {
  if (!state.upstreamOpen) {
    return;
  }

  const bufferedPayloads = state.outboundQueue.splice(
    0,
    state.outboundQueue.length
  );
  for (const payload of bufferedPayloads) {
    upstream.send(payload);
  }

  logInfo(options, "runtime.upstream.queue_flushed");
};

/**
 * Handles a client message and forwards or transforms it before sending upstream.
 *
 * @param rawData Raw WebSocket payload from browser client.
 * @param clientSocket Client-side WebSocket.
 * @param upstream OpenAI upstream socket.
 * @param state Mutable per-connection state.
 * @param options Runtime options.
 */
const handleClientMessage = (
  rawData: string | ArrayBufferLike | Blob,
  clientSocket: ClientSocket,
  upstream: UpstreamSocket,
  state: ProxyState,
  options: RuntimeRealtimeProxyOptions
): void => {
  const decoded = decodeClientPayload(rawData);

  if (decoded === null) {
    sendRuntimeError(clientSocket, "Client message must be valid UTF-8 text.");
    return;
  }

  const parsed = parseJsonObject(decoded);

  if (parsed === null) {
    sendRuntimeError(clientSocket, "Client message must be valid JSON.");
    return;
  }

  let protocolEvent: RuntimeClientProtocolEvent;

  try {
    protocolEvent = parseRuntimeClientProtocolEvent(parsed);
  } catch {
    sendRuntimeError(
      clientSocket,
      "Client message failed protocol validation."
    );
    return;
  }

  if (isRuntimeToolSuccessEvent(protocolEvent)) {
    sendToolSuccessToUpstream(protocolEvent, upstream, state, options);
    return;
  }

  sendToUpstream(JSON.stringify(protocolEvent), upstream, state);
};

/**
 * Converts a runtime tool success event into OpenAI client events.
 *
 * @param event Runtime tool success event.
 * @param upstream Upstream OpenAI socket.
 * @param state Mutable per-connection state.
 * @param options Runtime options.
 */
const sendToolSuccessToUpstream = (
  event: RuntimeToolSuccessEvent,
  upstream: UpstreamSocket,
  state: ProxyState,
  options: RuntimeRealtimeProxyOptions
): void => {
  const functionCallOutputEvent = {
    item: {
      call_id: event.callId,
      output: serializeToolSuccessEnvelope(event.output),
      type: "function_call_output"
    },
    type: "conversation.item.create"
  } satisfies OpenAIClientEvent;

  sendToUpstream(JSON.stringify(functionCallOutputEvent), upstream, state);

  const autoResponse = options.autoResponseAfterToolSuccess ?? true;

  if (!autoResponse) {
    return;
  }

  const responseCreateEvent = {
    response: {},
    type: "response.create"
  } satisfies OpenAIClientEvent;

  sendToUpstream(JSON.stringify(responseCreateEvent), upstream, state);
};

/**
 * Sends a payload to upstream immediately or queues it until connection opens.
 *
 * @param payload Serialized JSON payload.
 * @param upstream Upstream socket.
 * @param state Mutable per-connection state.
 */
const sendToUpstream = (
  payload: string,
  upstream: UpstreamSocket,
  state: ProxyState
): void => {
  if (!state.upstreamOpen) {
    state.outboundQueue.push(payload);
    return;
  }

  upstream.send(payload);
};

/**
 * Wires upstream event forwarding and lifecycle synchronization to client socket.
 *
 * @param upstream Upstream OpenAI socket.
 * @param clientSocket Client socket.
 * @param options Runtime options.
 */
const wireUpstreamToClient = (
  upstream: UpstreamSocket,
  clientSocket: ClientSocket,
  options: RuntimeRealtimeProxyOptions
): void => {
  upstream.on("message", (eventData) => {
    const serverPayload = decodeUpstreamPayload(eventData);

    if (serverPayload === null) {
      sendRuntimeError(clientSocket, "Received non-text upstream payload.");
      return;
    }

    const parsedEvent = parseJsonObject(serverPayload);

    if (parsedEvent === null) {
      sendRuntimeError(clientSocket, "Received invalid JSON from upstream.");
      return;
    }

    if (parsedEvent.type === "error") {
      logInfo(options, "runtime.upstream.error", {
        event: parsedEvent
      });
    }

    clientSocket.send(JSON.stringify(parsedEvent));
  });

  upstream.on("close", (code, reasonBuffer) => {
    clientSocket.close(code, reasonBuffer.toString("utf8"));
  });
};

/**
 * Decodes client payload into UTF-8 text.
 *
 * @param payload Raw payload from ws handler.
 * @returns Decoded text, or `null` if unsupported.
 */
const decodeClientPayload = (
  payload: string | ArrayBufferLike | Blob
): string | null => {
  if (typeof payload === "string") {
    return payload;
  }

  if (payload instanceof ArrayBuffer || payload instanceof SharedArrayBuffer) {
    return Buffer.from(payload).toString("utf8");
  }

  if (payload instanceof Blob) {
    // Blob text decoding is async; runtime currently rejects blob input to keep proxy sync-only.
  }

  return null;
};

/**
 * Decodes upstream payload into UTF-8 text.
 *
 * @param payload Raw upstream payload.
 * @returns Decoded text or `null` when payload is not textual.
 */
const decodeUpstreamPayload = (
  payload: Buffer | Buffer[] | string
): string | null => {
  if (typeof payload === "string") {
    return payload;
  }

  if (payload instanceof Buffer) {
    return payload.toString("utf8");
  }

  if (Array.isArray(payload)) {
    return Buffer.concat(payload).toString("utf8");
  }

  return null;
};

/**
 * Parses a string into a JSON object shape.
 *
 * @param serialized JSON string.
 * @returns Parsed object when valid, otherwise `null`.
 */
const parseJsonObject = (serialized: string): JsonObject | null => {
  try {
    const parsed: unknown = JSON.parse(serialized);
    const result = jsonObjectSchema.safeParse(parsed);

    if (!result.success) {
      return null;
    }

    return result.data;
  } catch {
    return null;
  }
};

/**
 * Sends a structured runtime error event to the browser client.
 *
 * @param clientSocket Client WebSocket.
 * @param message Human-readable error message.
 */
const sendRuntimeError = (
  clientSocket: ClientSocket,
  message: string
): void => {
  clientSocket.send(
    JSON.stringify({
      error: {
        message,
        type: "runtime_proxy_error"
      },
      type: "error"
    })
  );
};

/**
 * Emits informational logs via configured sink.
 *
 * @param options Runtime options.
 * @param message Log message.
 * @param details Optional structured detail fields.
 */
const logInfo = (
  options: RuntimeRealtimeProxyOptions,
  message: string,
  details?: Record<string, unknown>
): void => {
  options.onLog?.(message, details);
};

/**
 * Converts unknown error-like values into loggable messages.
 *
 * @param error Unknown thrown/error value.
 * @returns String message suitable for logs.
 */
const toErrorMessage = (error: unknown): string => {
  if (error instanceof Error) {
    return error.message;
  }

  if (typeof error === "string") {
    return error;
  }

  return "Unknown error";
};
