import { Observable, Subject } from "rxjs";
import { z } from "zod";

import {
  isFunctionCallArgumentsDeltaEvent,
  isFunctionCallArgumentsDoneEvent,
  parseCoreClientEvent,
  parseCoreServerEvent
} from "./protocol";
import type {
  CoreClientEvent,
  CoreServerEvent,
  CreateRealtimeClientOptions,
  RealtimeClient,
  RuntimeToolSuccessEnvelope,
  ToolCallStart,
  ToolCallSuccessInput,
  WebSocketLike
} from "./types";

const OPEN_STATE = 1;
const jsonRecordSchema = z.record(z.string(), z.unknown());

/**
 * Creates a runtime-aware realtime websocket client for browser integrations.
 *
 * @param options Connection options.
 * @returns Realtime client API.
 */
export const createRealtimeClient = (
  options: CreateRealtimeClientOptions
): RealtimeClient => {
  const eventsSubject = new Subject<CoreServerEvent>();
  const toolCallStartsSubject = new Subject<ToolCallStart>();
  const callArgumentStreams = new Map<string, Subject<string>>();

  let socket: WebSocketLike | null = null;

  const send = (event: CoreClientEvent): void => {
    let validatedEvent: CoreClientEvent;

    try {
      validatedEvent = parseCoreClientEvent(event);
    } catch {
      eventsSubject.next(
        createLocalErrorEvent("Client payload failed validation.")
      );
      return;
    }

    if (socket === null || socket.readyState !== OPEN_STATE) {
      eventsSubject.next(
        createLocalErrorEvent("Cannot send before websocket is open.")
      );
      return;
    }

    try {
      socket.send(JSON.stringify(validatedEvent));
    } catch {
      eventsSubject.next(
        createLocalErrorEvent("Client payload is not JSON serializable.")
      );
    }
  };

  const reportToolSuccess = (input: ToolCallSuccessInput): void => {
    const event: CoreClientEvent = {
      callId: input.callId,
      output: input.output,
      type: "runtime.tool.success"
    };

    send(event);
  };

  const connect = (): void => {
    if (socket !== null) {
      return;
    }

    try {
      socket = createSocket(options);
    } catch {
      eventsSubject.next(
        createLocalErrorEvent("Unable to create websocket transport.")
      );
      return;
    }

    socket.onopen = () => {
      return;
    };

    socket.onmessage = (message) => {
      handleIncomingMessage(
        message.data,
        eventsSubject,
        toolCallStartsSubject,
        callArgumentStreams,
        reportToolSuccess
      );
    };

    socket.onerror = () => {
      eventsSubject.next(createLocalErrorEvent("WebSocket transport error."));
    };

    socket.onclose = () => {
      completeCallStreams(callArgumentStreams);
      socket = null;
    };
  };

  const disconnect = (): void => {
    if (socket === null) {
      return;
    }

    socket.close(1000, "Client requested disconnect");
    completeCallStreams(callArgumentStreams);
    socket = null;
  };

  return {
    connect,
    disconnect,
    events$: eventsSubject.asObservable(),
    reportToolSuccess,
    send,
    toolCallStarts$: toolCallStartsSubject.asObservable()
  };
};

/**
 * Creates a websocket instance from configuration.
 *
 * @param options Client options.
 * @returns WebSocket instance.
 */
const createSocket = (options: CreateRealtimeClientOptions): WebSocketLike => {
  if (options.socketFactory !== undefined) {
    return options.socketFactory(options.url);
  }

  if (typeof WebSocket === "undefined") {
    throw new Error("Global WebSocket is not available.");
  }

  return createBrowserSocketAdapter(options.url);
};

/**
 * Creates a `WebSocketLike` adapter for native browser `WebSocket`.
 *
 * @param url Runtime websocket URL.
 * @returns Socket adapter with callback-style hooks.
 */
const createBrowserSocketAdapter = (url: string): WebSocketLike => {
  const socket = new WebSocket(url);
  const adapter: WebSocketLike = {
    close: (code?: number, reason?: string) => {
      socket.close(code, reason);
    },
    onclose: null,
    onerror: null,
    onmessage: null,
    onopen: null,
    get readyState() {
      return socket.readyState;
    },
    send: (payload: string) => {
      socket.send(payload);
    }
  };

  socket.addEventListener("open", () => {
    adapter.onopen?.();
  });

  socket.addEventListener("message", (event) => {
    if (typeof event.data === "string") {
      adapter.onmessage?.({ data: event.data });
      return;
    }

    adapter.onerror?.(new Error("Non-text websocket message received."));
  });

  socket.addEventListener("error", (event) => {
    adapter.onerror?.(event);
  });

  socket.addEventListener("close", (event) => {
    adapter.onclose?.({
      code: event.code,
      reason: event.reason
    });
  });

  return adapter;
};

/**
 * Handles a single inbound websocket message from runtime.
 *
 * @param serialized Serialized message string.
 * @param eventsSubject Subject for all server events.
 * @param toolCallStartsSubject Subject for new tool call streams.
 * @param callArgumentStreams Per-call stream map.
 * @param reportToolSuccess Function for reporting tool outputs.
 */
const handleIncomingMessage = (
  serialized: string,
  eventsSubject: Subject<CoreServerEvent>,
  toolCallStartsSubject: Subject<ToolCallStart>,
  callArgumentStreams: Map<string, Subject<string>>,
  reportToolSuccess: (input: ToolCallSuccessInput) => void
): void => {
  const parsedJson = parseJsonRecord(serialized);

  if (parsedJson === null) {
    eventsSubject.next(createLocalErrorEvent("Received invalid JSON payload."));
    return;
  }

  let event: CoreServerEvent;

  try {
    event = parseCoreServerEvent(parsedJson);
  } catch {
    eventsSubject.next(
      createLocalErrorEvent("Received invalid event envelope.")
    );
    return;
  }

  if (isFunctionCallArgumentsDeltaEvent(event)) {
    const existingStream = callArgumentStreams.get(event.call_id);

    if (existingStream === undefined) {
      const nextStream = new Subject<string>();
      callArgumentStreams.set(event.call_id, nextStream);
      toolCallStartsSubject.next({
        argumentChunks$: nextStream.asObservable(),
        callId: event.call_id,
        itemId: event.item_id,
        reportSuccess: (output: RuntimeToolSuccessEnvelope) => {
          reportToolSuccess({
            callId: event.call_id,
            output
          });
        },
        responseId: event.response_id
      });
      nextStream.next(event.delta);
    } else {
      existingStream.next(event.delta);
    }
  }

  if (isFunctionCallArgumentsDoneEvent(event)) {
    const stream = callArgumentStreams.get(event.call_id);

    if (stream !== undefined) {
      stream.complete();
      callArgumentStreams.delete(event.call_id);
    }
  }

  eventsSubject.next(event);
};

/**
 * Parses serialized JSON into an object record.
 *
 * @param serialized Raw json string.
 * @returns Parsed object record or `null`.
 */
const parseJsonRecord = (
  serialized: string
): Record<string, unknown> | null => {
  try {
    const parsed: unknown = JSON.parse(serialized);
    const result = jsonRecordSchema.safeParse(parsed);
    if (!result.success) {
      return null;
    }
    return result.data;
  } catch {
    return null;
  }
};

/**
 * Completes and clears all outstanding call argument streams.
 *
 * @param callArgumentStreams Mutable map of call id to chunk stream.
 */
const completeCallStreams = (
  callArgumentStreams: Map<string, Subject<string>>
): void => {
  callArgumentStreams.forEach((stream) => {
    stream.complete();
  });

  callArgumentStreams.clear();
};

/**
 * Creates a local error event envelope for transport/protocol failures.
 *
 * @param message Human-readable error message.
 * @returns Error event payload.
 */
const createLocalErrorEvent = (message: string): CoreServerEvent => {
  return {
    error: {
      message,
      type: "core_client_error"
    },
    type: "error"
  };
};

/**
 * Re-exports observable type to make API docs explicit.
 */
export type { Observable };
