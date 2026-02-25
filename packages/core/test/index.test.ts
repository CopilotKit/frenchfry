import { expect, test } from "vitest";
import { z } from "zod";

import {
  CORE_PACKAGE_NAME,
  createRealtimeClient,
  isErrorEvent,
  isFunctionCallArgumentsDeltaEvent,
  isFunctionCallArgumentsDoneEvent,
  isRuntimeToolSuccessEvent,
  parseCoreClientEvent,
  parseCoreServerEvent,
  toUnknownServerEvent,
  type RuntimeToolSuccessEnvelope,
  type ToolCallStart,
  type WebSocketLike
} from "../src/index";

class FakeSocket implements WebSocketLike {
  public onclose:
    | ((event: {
        code: number | undefined;
        reason: string | undefined;
      }) => void)
    | null = null;

  public onerror: ((event: unknown) => void) | null = null;

  public onmessage: ((event: { data: string }) => void) | null = null;

  public onopen: (() => void) | null = null;

  public readyState = 0;

  public readonly sentPayloads: string[] = [];

  public close(code?: number, reason?: string): void {
    this.readyState = 3;
    this.onclose?.({ code, reason });
  }

  public emitMessage(payload: Record<string, unknown>): void {
    this.onmessage?.({ data: JSON.stringify(payload) });
  }

  public open(): void {
    this.readyState = 1;
    this.onopen?.();
  }

  public send(payload: string): void {
    this.sentPayloads.push(payload);
  }
}

/**
 * Parses a serialized JSON payload and validates object shape.
 *
 * @param serialized Serialized payload.
 * @returns Parsed object record.
 */
const parsePayloadRecord = (serialized: string): Record<string, unknown> => {
  const parsed: unknown = JSON.parse(serialized);
  const parsedResult = z.record(z.string(), z.unknown()).safeParse(parsed);
  if (!parsedResult.success) {
    throw new Error("Expected object payload.");
  }
  return parsedResult.data;
};

test("core package exposes a stable name marker", () => {
  // Arrange
  const expectedName = "@frenchfryai/core";

  // Act
  const actualName = CORE_PACKAGE_NAME;

  // Assert
  expect(actualName).toBe(expectedName);
});

test("toolCallStarts$ emits once per call id and streams chunks in order", () => {
  // Arrange
  const socket = new FakeSocket();
  const client = createRealtimeClient({
    socketFactory: () => socket,
    url: "ws://localhost/realtime/ws"
  });

  const starts: ToolCallStart[] = [];
  const chunks: string[] = [];

  client.toolCallStarts$.subscribe((start) => {
    starts.push(start);
    start.argumentChunks$.subscribe((chunk) => {
      chunks.push(chunk);
    });
  });

  client.connect();
  socket.open();

  // Act
  socket.emitMessage({
    call_id: "call_1",
    delta: '{"city":"San',
    item_id: "fc_1",
    output_index: 0,
    response_id: "resp_1",
    type: "response.function_call_arguments.delta"
  });
  socket.emitMessage({
    call_id: "call_1",
    delta: ' Francisco"}',
    item_id: "fc_1",
    output_index: 0,
    response_id: "resp_1",
    type: "response.function_call_arguments.delta"
  });

  // Assert
  expect(starts).toHaveLength(1);
  const firstStart = starts.at(0);
  if (firstStart === undefined) {
    throw new Error("Expected first tool call start.");
  }
  expect(firstStart.callId).toBe("call_1");
  expect(chunks).toEqual(['{"city":"San', ' Francisco"}']);
});

test("argument stream completes when done event arrives", () => {
  // Arrange
  const socket = new FakeSocket();
  const client = createRealtimeClient({
    socketFactory: () => socket,
    url: "ws://localhost/realtime/ws"
  });

  let completed = false;

  client.toolCallStarts$.subscribe((start) => {
    start.argumentChunks$.subscribe({
      complete: () => {
        completed = true;
      }
    });
  });

  client.connect();
  socket.open();
  socket.emitMessage({
    call_id: "call_2",
    delta: "{}",
    item_id: "fc_2",
    output_index: 0,
    response_id: "resp_2",
    type: "response.function_call_arguments.delta"
  });

  // Act
  socket.emitMessage({
    arguments: "{}",
    call_id: "call_2",
    item_id: "fc_2",
    output_index: 0,
    response_id: "resp_2",
    type: "response.function_call_arguments.done"
  });

  // Assert
  expect(completed).toBe(true);
});

test("reportToolSuccess sends runtime tool success event", () => {
  // Arrange
  const socket = new FakeSocket();
  const client = createRealtimeClient({
    socketFactory: () => socket,
    url: "ws://localhost/realtime/ws"
  });

  client.connect();
  socket.open();

  // Act
  client.reportToolSuccess({
    callId: "call_3",
    output: {
      ok: true
    }
  });

  // Assert
  expect(socket.sentPayloads).toHaveLength(1);
  const firstPayload = socket.sentPayloads.at(0);
  if (firstPayload === undefined) {
    throw new Error("Expected payload to exist.");
  }
  expect(JSON.parse(firstPayload)).toEqual({
    callId: "call_3",
    output: {
      ok: true
    },
    type: "runtime.tool.success"
  });
});

test("toolCallStart reportSuccess sends bound call id", () => {
  // Arrange
  const socket = new FakeSocket();
  const client = createRealtimeClient({
    socketFactory: () => socket,
    url: "ws://localhost/realtime/ws"
  });

  const outputs: RuntimeToolSuccessEnvelope[] = [];

  client.toolCallStarts$.subscribe((start) => {
    const output = {
      data: { ok: "yes" },
      ok: true
    } satisfies RuntimeToolSuccessEnvelope;

    outputs.push(output);
    start.reportSuccess(output);
  });

  client.connect();
  socket.open();

  // Act
  socket.emitMessage({
    call_id: "call_bound",
    delta: "{}",
    item_id: "fc_3",
    output_index: 0,
    response_id: "resp_3",
    type: "response.function_call_arguments.delta"
  });

  // Assert
  expect(outputs).toHaveLength(1);
  const firstPayload = socket.sentPayloads.at(0);
  if (firstPayload === undefined) {
    throw new Error("Expected payload to exist.");
  }
  expect(JSON.parse(firstPayload)).toEqual({
    callId: "call_bound",
    output: {
      data: { ok: "yes" },
      ok: true
    },
    type: "runtime.tool.success"
  });
});

test("disconnect completes active call streams", () => {
  // Arrange
  const socket = new FakeSocket();
  const client = createRealtimeClient({
    socketFactory: () => socket,
    url: "ws://localhost/realtime/ws"
  });

  let completed = false;

  client.toolCallStarts$.subscribe((start) => {
    start.argumentChunks$.subscribe({
      complete: () => {
        completed = true;
      }
    });
  });

  client.connect();
  socket.open();
  socket.emitMessage({
    call_id: "call_disconnect",
    delta: "{}",
    item_id: "fc_4",
    output_index: 0,
    response_id: "resp_4",
    type: "response.function_call_arguments.delta"
  });

  // Act
  client.disconnect();

  // Assert
  expect(completed).toBe(true);
});

test("invalid inbound json emits a client error event", () => {
  // Arrange
  const socket = new FakeSocket();
  const client = createRealtimeClient({
    socketFactory: () => socket,
    url: "ws://localhost/realtime/ws"
  });

  const eventTypes: string[] = [];

  client.events$.subscribe((event) => {
    if (event.type === "error") {
      eventTypes.push(event.type);
    }
  });

  client.connect();
  socket.open();

  // Act
  socket.onmessage?.({ data: "{" });

  // Assert
  expect(eventTypes).toEqual(["error"]);
});

test("connect and disconnect emit connection lifecycle events", () => {
  // Arrange
  const socket = new FakeSocket();
  const client = createRealtimeClient({
    socketFactory: () => socket,
    url: "ws://localhost/realtime/ws"
  });
  const eventTypes: string[] = [];

  client.events$.subscribe((event) => {
    eventTypes.push(event.type);
  });

  client.connect();

  // Act
  socket.open();
  client.disconnect();

  // Assert
  expect(eventTypes).toContain("runtime.connection.open");
  expect(eventTypes).toContain("runtime.connection.closed");
});

test("invalid event envelope emits protocol error event", () => {
  // Arrange
  const socket = new FakeSocket();
  const client = createRealtimeClient({
    socketFactory: () => socket,
    url: "ws://localhost/realtime/ws"
  });
  const messages: string[] = [];
  client.events$.subscribe((event) => {
    if (isErrorEvent(event)) {
      messages.push(event.error.message);
    }
  });
  client.connect();
  socket.open();

  // Act
  socket.emitMessage({ foo: "bar" });

  // Assert
  expect(messages).toContain("Received invalid event envelope.");
});

test("json arrays are rejected as invalid payloads", () => {
  // Arrange
  const socket = new FakeSocket();
  const client = createRealtimeClient({
    socketFactory: () => socket,
    url: "ws://localhost/realtime/ws"
  });
  const messages: string[] = [];
  client.events$.subscribe((event) => {
    if (isErrorEvent(event)) {
      messages.push(event.error.message);
    }
  });
  client.connect();
  socket.open();

  // Act
  socket.onmessage?.({ data: "[]" });

  // Assert
  expect(messages).toContain("Received invalid JSON payload.");
});

test("send before open emits client error event", () => {
  // Arrange
  const socket = new FakeSocket();
  const client = createRealtimeClient({
    socketFactory: () => socket,
    url: "ws://localhost/realtime/ws"
  });
  const messages: string[] = [];
  client.events$.subscribe((event) => {
    if (isErrorEvent(event)) {
      messages.push(event.error.message);
    }
  });
  client.connect();

  // Act
  client.send({ type: "response.create" });

  // Assert
  expect(messages).toEqual(["Cannot send before websocket is open."]);
});

test("invalid outgoing event emits validation error", () => {
  // Arrange
  const socket = new FakeSocket();
  const client = createRealtimeClient({
    socketFactory: () => socket,
    url: "ws://localhost/realtime/ws"
  });
  const messages: string[] = [];
  client.events$.subscribe((event) => {
    if (isErrorEvent(event)) {
      messages.push(event.error.message);
    }
  });
  client.connect();
  socket.open();

  // Act
  client.send({ type: "" });

  // Assert
  expect(messages).toContain("Client payload failed validation.");
});

test("non-JSON client payload emits validation error without throwing", () => {
  // Arrange
  const socket = new FakeSocket();
  const client = createRealtimeClient({
    socketFactory: () => socket,
    url: "ws://localhost/realtime/ws"
  });
  const messages: string[] = [];
  client.events$.subscribe((event) => {
    if (isErrorEvent(event)) {
      messages.push(event.error.message);
    }
  });
  client.connect();
  socket.open();

  // Act
  client.send({
    bigint: 1n,
    type: "response.create"
  });

  // Assert
  expect(messages).toContain("Client payload failed validation.");
});

test("serialization or send failure emits structured client error", () => {
  // Arrange
  const socket = new FakeSocket();
  socket.send = () => {
    throw new Error("send failed");
  };
  const client = createRealtimeClient({
    socketFactory: () => socket,
    url: "ws://localhost/realtime/ws"
  });
  const messages: string[] = [];
  client.events$.subscribe((event) => {
    if (isErrorEvent(event)) {
      messages.push(event.error.message);
    }
  });
  client.connect();
  socket.open();

  // Act
  client.send({ type: "response.create" });

  // Assert
  expect(messages).toContain("Client payload is not JSON serializable.");
});

test("socket transport error emits error event", () => {
  // Arrange
  const socket = new FakeSocket();
  const client = createRealtimeClient({
    socketFactory: () => socket,
    url: "ws://localhost/realtime/ws"
  });
  const messages: string[] = [];
  client.events$.subscribe((event) => {
    if (isErrorEvent(event)) {
      messages.push(event.error.message);
    }
  });
  client.connect();
  socket.open();

  // Act
  socket.onerror?.(new Error("boom"));

  // Assert
  expect(messages).toContain("WebSocket transport error.");
});

test("connect handles socket creation failure", () => {
  // Arrange
  const client = createRealtimeClient({
    socketFactory: () => {
      throw new Error("factory failed");
    },
    url: "ws://localhost/realtime/ws"
  });
  const messages: string[] = [];
  client.events$.subscribe((event) => {
    if (isErrorEvent(event)) {
      messages.push(event.error.message);
    }
  });

  // Act
  client.connect();

  // Assert
  expect(messages).toEqual(["Unable to create websocket transport."]);
});

test("connect is idempotent and disconnect handles idle state", () => {
  // Arrange
  const socket = new FakeSocket();
  let factoryCalls = 0;
  const client = createRealtimeClient({
    socketFactory: () => {
      factoryCalls += 1;
      return socket;
    },
    url: "ws://localhost/realtime/ws"
  });

  // Act
  client.disconnect();
  client.connect();
  client.connect();

  // Assert
  expect(factoryCalls).toBe(1);
});

test("missing global WebSocket emits transport creation error", () => {
  // Arrange
  const originalWebSocket = globalThis.WebSocket;
  Reflect.deleteProperty(globalThis, "WebSocket");
  const client = createRealtimeClient({
    url: "ws://localhost/runtime"
  });
  const messages: string[] = [];
  client.events$.subscribe((event) => {
    if (isErrorEvent(event)) {
      messages.push(event.error.message);
    }
  });

  try {
    // Act
    client.connect();
  } finally {
    Reflect.set(globalThis, "WebSocket", originalWebSocket);
  }

  // Assert
  expect(messages).toContain("Unable to create websocket transport.");
});

test("parse and guard helpers cover known and unknown events", () => {
  // Arrange
  const delta = parseCoreServerEvent({
    call_id: "call",
    delta: "{}",
    item_id: "fc",
    output_index: 0,
    response_id: "resp",
    type: "response.function_call_arguments.delta"
  });
  const done = parseCoreServerEvent({
    arguments: "{}",
    call_id: "call",
    item_id: "fc",
    output_index: 0,
    response_id: "resp",
    type: "response.function_call_arguments.done"
  });
  const unknown = parseCoreServerEvent({
    foo: "bar",
    type: "custom.event"
  });
  const clientEvent = parseCoreClientEvent({
    callId: "call",
    output: { ok: true },
    type: "runtime.tool.success"
  });

  // Act
  const unknownNormalized = toUnknownServerEvent(unknown);

  // Assert
  expect(isFunctionCallArgumentsDeltaEvent(delta)).toBe(true);
  expect(isFunctionCallArgumentsDoneEvent(done)).toBe(true);
  expect(isErrorEvent(unknown)).toBe(false);
  expect(unknownNormalized.type).toBe("custom.event");
  expect(isRuntimeToolSuccessEvent(clientEvent)).toBe(true);
});

test("parse helpers reject invalid payload shapes", () => {
  // Arrange / Act / Assert
  expect(() => parseCoreServerEvent({})).toThrowError(
    "Server payload is not a valid event envelope."
  );
  expect(() => parseCoreClientEvent({ type: "" })).toThrowError(
    "Client payload is not a valid event envelope."
  );
});

test("browser adapter path handles open, message, error, and close events", () => {
  // Arrange
  type Listener = (event?: unknown) => void;
  type ListenerMap = Record<"close" | "error" | "message" | "open", Listener[]>;

  class BrowserSocketStub {
    public static latest: BrowserSocketStub | null = null;

    public readyState = 0;

    public readonly listeners: ListenerMap = {
      close: [],
      error: [],
      message: [],
      open: []
    };

    public readonly sentPayloads: string[] = [];

    public constructor(public readonly url: string) {
      BrowserSocketStub.latest = this;
    }

    public addEventListener<K extends keyof ListenerMap>(
      type: K,
      listener: Listener
    ): void {
      this.listeners[type].push(listener);
    }

    public close(code?: number, reason?: string): void {
      this.readyState = 3;
      this.listeners.close.forEach((listener) => {
        listener({
          code: code ?? 1000,
          reason: reason ?? ""
        });
      });
    }

    public send(payload: string): void {
      this.sentPayloads.push(payload);
    }
  }

  const originalWebSocket = globalThis.WebSocket;
  Reflect.set(globalThis, "WebSocket", BrowserSocketStub);

  try {
    const client = createRealtimeClient({
      url: "ws://localhost/runtime"
    });
    const events: string[] = [];
    client.events$.subscribe((event) => {
      events.push(event.type);
    });

    client.connect();

    const browserSocket = BrowserSocketStub.latest;
    if (browserSocket === null) {
      throw new Error("Expected browser socket instance.");
    }

    // Act
    browserSocket.readyState = 1;
    browserSocket.listeners.open.forEach((listener) => {
      listener();
    });
    client.send({ type: "response.create" });
    browserSocket.listeners.message.forEach((listener) => {
      listener({
        data: JSON.stringify({
          type: "response.done"
        })
      });
    });
    browserSocket.listeners.message.forEach((listener) => {
      listener({
        data: new Uint8Array([1, 2, 3])
      });
    });
    browserSocket.listeners.error.forEach((listener) => {
      listener(new Error("transport"));
    });
    client.disconnect();

    // Assert
    const firstPayload = browserSocket.sentPayloads.at(0);
    if (firstPayload === undefined) {
      throw new Error("Expected outbound payload.");
    }
    expect(parsePayloadRecord(firstPayload)).toEqual({
      type: "response.create"
    });
    expect(events).toContain("response.done");
    expect(events).toContain("error");
  } finally {
    Reflect.set(globalThis, "WebSocket", originalWebSocket);
  }
});
