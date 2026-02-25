import { EventEmitter } from "node:events";

import { Hono } from "hono";
import { expect, test } from "vitest";
import { z } from "zod";

import {
  RUNTIME_PACKAGE_NAME,
  buildOpenAIHeaders,
  buildOpenAIRealtimeUrl,
  registerRealtimeProxy,
  type ClientSocket,
  type RuntimeNodeWebSocketAdapter,
  type UpstreamSocket
} from "../src/index";

class FakeUpstreamSocket extends EventEmitter implements UpstreamSocket {
  public readonly closeCalls: Array<{
    code: number | undefined;
    reason: string | undefined;
  }> = [];

  public readonly sentPayloads: string[] = [];

  public close(code?: number, reason?: string): void {
    this.closeCalls.push({ code, reason });
    this.emit("close", code ?? 1000, Buffer.from(reason ?? ""));
  }

  public send(payload: string): void {
    this.sentPayloads.push(payload);
  }
}

class FakeClientSocket implements ClientSocket {
  public readonly closeCalls: Array<{
    code: number | undefined;
    reason: string | undefined;
  }> = [];

  public readonly sentPayloads: string[] = [];

  public close(code?: number, reason?: string): void {
    this.closeCalls.push({ code, reason });
  }

  public send(payload: string | ArrayBuffer | Uint8Array<ArrayBuffer>): void {
    if (typeof payload !== "string") {
      throw new Error("Expected JSON text payload in tests.");
    }
    this.sentPayloads.push(payload);
  }
}

type Lifecycle = {
  onClose: (event: unknown, socket: ClientSocket) => void;
  onMessage: (
    event: { data: string | ArrayBufferLike | Blob },
    socket: ClientSocket
  ) => void;
  onOpen: (event: unknown, socket: ClientSocket) => void;
};

/**
 * Creates a minimal node websocket adapter for capturing lifecycle handlers in tests.
 *
 * @param sink Mutable sink where the registered lifecycle factory is written.
 * @returns Runtime node websocket adapter stub.
 */
const createNodeWebSocketAdapterStub = (sink: {
  lifecycleFactory?: (context: unknown) => Lifecycle;
}): RuntimeNodeWebSocketAdapter => {
  return {
    injectWebSocket: () => {
      return;
    },
    upgradeWebSocket: (configure) => {
      sink.lifecycleFactory = configure;

      return () => {
        return new Response("ok");
      };
    }
  };
};

/**
 * Parses a serialized JSON message produced by socket test doubles.
 *
 * @param serialized JSON string payload.
 * @returns Parsed object payload.
 */
const parseSentPayload = (serialized: string): Record<string, unknown> => {
  const parsed: unknown = JSON.parse(serialized);
  const parsedResult = z.record(z.string(), z.unknown()).safeParse(parsed);
  if (!parsedResult.success) {
    throw new Error("Expected JSON object payload.");
  }
  return parsedResult.data;
};

/**
 * Retrieves a payload from the socket payload list, throwing when missing.
 *
 * @param payloads Serialized payload list.
 * @param index Target index.
 * @returns Payload string at index.
 */
const getPayloadAt = (payloads: string[], index: number): string => {
  const payload = payloads.at(index);
  if (payload === undefined) {
    throw new Error(`Expected payload at index ${index}.`);
  }
  return payload;
};

test("runtime package exposes a stable name marker", () => {
  // Arrange
  const expectedName = "@frenchfryai/runtime";

  // Act
  const actualName = RUNTIME_PACKAGE_NAME;

  // Assert
  expect(actualName).toBe(expectedName);
});

test("buildOpenAIRealtimeUrl defaults to gpt-realtime model", () => {
  // Arrange
  const options = {
    apiKey: "test-key"
  };

  // Act
  const url = buildOpenAIRealtimeUrl(options);

  // Assert
  expect(url).toBe("wss://api.openai.com/v1/realtime?model=gpt-realtime");
});

test("buildOpenAIHeaders omits beta header by default", () => {
  // Arrange
  const options = {
    apiKey: "test-key"
  };

  // Act
  const headers = buildOpenAIHeaders(options);

  // Assert
  expect(headers.Authorization).toBe("Bearer test-key");
  expect(headers["OpenAI-Beta"]).toBeUndefined();
});

test("buildOpenAIHeaders includes beta header when configured", () => {
  // Arrange
  const options = {
    apiKey: "test-key",
    includeBetaHeader: true
  };

  // Act
  const headers = buildOpenAIHeaders(options);

  // Assert
  expect(headers["OpenAI-Beta"]).toBe("realtime=v1");
});

test("buildOpenAIHeaders includes organization and project headers", () => {
  // Arrange
  const options = {
    apiKey: "test-key",
    organization: "org_1",
    project: "proj_1"
  };

  // Act
  const headers = buildOpenAIHeaders(options);

  // Assert
  expect(headers["OpenAI-Organization"]).toBe("org_1");
  expect(headers["OpenAI-Project"]).toBe("proj_1");
});

test("registerRealtimeProxy uses default route path", () => {
  // Arrange
  const app = new Hono();

  // Act
  const registration = registerRealtimeProxy(app, {
    createNodeWebSocket: () => createNodeWebSocketAdapterStub({}),
    openai: {
      apiKey: "test-key"
    }
  });

  // Assert
  expect(registration.path).toBe("/realtime/ws");
  expect(app.routes.some((route) => route.path === "/realtime/ws")).toBe(true);
});

test("registerRealtimeProxy uses custom route path", () => {
  // Arrange
  const app = new Hono();

  // Act
  const registration = registerRealtimeProxy(app, {
    createNodeWebSocket: () => createNodeWebSocketAdapterStub({}),
    openai: {
      apiKey: "test-key"
    },
    path: "/ws/custom"
  });

  // Assert
  expect(registration.path).toBe("/ws/custom");
  expect(app.routes.some((route) => route.path === "/ws/custom")).toBe(true);
});

test("runtime converts tool success event to function_call_output and response.create", () => {
  // Arrange
  const app = new Hono();
  const fakeUpstreamSocket = new FakeUpstreamSocket();
  const fakeClientSocket = new FakeClientSocket();
  const sink: { lifecycleFactory?: (context: unknown) => Lifecycle } = {};

  registerRealtimeProxy(app, {
    createNodeWebSocket: () => createNodeWebSocketAdapterStub(sink),
    createUpstreamSocket: () => fakeUpstreamSocket,
    openai: {
      apiKey: "test-key"
    }
  });

  if (sink.lifecycleFactory === undefined) {
    throw new Error("Expected websocket lifecycle factory to be captured.");
  }

  const lifecycle = sink.lifecycleFactory({});

  // Act
  lifecycle.onOpen({}, fakeClientSocket);
  fakeUpstreamSocket.emit("open");
  lifecycle.onMessage(
    {
      data: JSON.stringify({
        callId: "call_123",
        output: {
          data: { city: "San Francisco" },
          ok: true
        },
        type: "runtime.tool.success"
      })
    },
    fakeClientSocket
  );

  // Assert
  expect(fakeUpstreamSocket.sentPayloads).toHaveLength(2);

  const firstPayload = fakeUpstreamSocket.sentPayloads.at(0);
  const secondPayload = fakeUpstreamSocket.sentPayloads.at(1);
  if (firstPayload === undefined || secondPayload === undefined) {
    throw new Error("Expected two upstream payloads.");
  }
  const firstEvent = parseSentPayload(firstPayload);
  const secondEvent = parseSentPayload(secondPayload);

  expect(firstEvent.type).toBe("conversation.item.create");
  expect(firstEvent.item).toEqual({
    call_id: "call_123",
    output: JSON.stringify({ data: { city: "San Francisco" }, ok: true }),
    type: "function_call_output"
  });
  expect(secondEvent.type).toBe("response.create");
});

test("runtime forwards upstream events to client unchanged", () => {
  // Arrange
  const app = new Hono();
  const fakeUpstreamSocket = new FakeUpstreamSocket();
  const fakeClientSocket = new FakeClientSocket();
  const sink: { lifecycleFactory?: (context: unknown) => Lifecycle } = {};

  registerRealtimeProxy(app, {
    createNodeWebSocket: () => createNodeWebSocketAdapterStub(sink),
    createUpstreamSocket: () => fakeUpstreamSocket,
    openai: {
      apiKey: "test-key"
    }
  });

  if (sink.lifecycleFactory === undefined) {
    throw new Error("Expected websocket lifecycle factory to be captured.");
  }

  const lifecycle = sink.lifecycleFactory({});

  // Act
  lifecycle.onOpen({}, fakeClientSocket);
  fakeUpstreamSocket.emit("open");
  fakeUpstreamSocket.emit(
    "message",
    JSON.stringify({
      delta: "hello",
      type: "response.output_text.delta"
    })
  );

  // Assert
  expect(fakeClientSocket.sentPayloads).toHaveLength(1);
  const firstPayload = fakeClientSocket.sentPayloads.at(0);
  if (firstPayload === undefined) {
    throw new Error("Expected one client payload.");
  }
  expect(parseSentPayload(firstPayload)).toEqual({
    delta: "hello",
    type: "response.output_text.delta"
  });
});

test("runtime emits error event when client payload is invalid JSON", () => {
  // Arrange
  const app = new Hono();
  const fakeUpstreamSocket = new FakeUpstreamSocket();
  const fakeClientSocket = new FakeClientSocket();
  const sink: { lifecycleFactory?: (context: unknown) => Lifecycle } = {};

  registerRealtimeProxy(app, {
    createNodeWebSocket: () => createNodeWebSocketAdapterStub(sink),
    createUpstreamSocket: () => fakeUpstreamSocket,
    openai: {
      apiKey: "test-key"
    }
  });

  if (sink.lifecycleFactory === undefined) {
    throw new Error("Expected websocket lifecycle factory to be captured.");
  }

  const lifecycle = sink.lifecycleFactory({});

  // Act
  lifecycle.onOpen({}, fakeClientSocket);
  lifecycle.onMessage({ data: "{" }, fakeClientSocket);

  // Assert
  expect(fakeClientSocket.sentPayloads).toHaveLength(1);
  const firstPayload = fakeClientSocket.sentPayloads.at(0);
  if (firstPayload === undefined) {
    throw new Error("Expected one client payload.");
  }
  expect(parseSentPayload(firstPayload)).toEqual({
    error: {
      message: "Client message must be valid JSON.",
      type: "runtime_proxy_error"
    },
    type: "error"
  });
});

test("runtime queues passthrough event until upstream opens", () => {
  // Arrange
  const app = new Hono();
  const fakeUpstreamSocket = new FakeUpstreamSocket();
  const fakeClientSocket = new FakeClientSocket();
  const sink: { lifecycleFactory?: (context: unknown) => Lifecycle } = {};

  registerRealtimeProxy(app, {
    createNodeWebSocket: () => createNodeWebSocketAdapterStub(sink),
    createUpstreamSocket: () => fakeUpstreamSocket,
    openai: {
      apiKey: "test-key"
    }
  });

  if (sink.lifecycleFactory === undefined) {
    throw new Error("Expected websocket lifecycle factory to be captured.");
  }

  const lifecycle = sink.lifecycleFactory({});

  // Act
  lifecycle.onOpen({}, fakeClientSocket);
  lifecycle.onMessage(
    {
      data: JSON.stringify({ type: "response.cancel" })
    },
    fakeClientSocket
  );
  expect(fakeUpstreamSocket.sentPayloads).toHaveLength(0);
  fakeUpstreamSocket.emit("open");

  // Assert
  expect(fakeUpstreamSocket.sentPayloads).toHaveLength(1);
  expect(
    parseSentPayload(getPayloadAt(fakeUpstreamSocket.sentPayloads, 0))
  ).toEqual({
    type: "response.cancel"
  });
});

test("runtime handles unsupported client payload type", () => {
  // Arrange
  const app = new Hono();
  const fakeUpstreamSocket = new FakeUpstreamSocket();
  const fakeClientSocket = new FakeClientSocket();
  const sink: { lifecycleFactory?: (context: unknown) => Lifecycle } = {};

  registerRealtimeProxy(app, {
    createNodeWebSocket: () => createNodeWebSocketAdapterStub(sink),
    createUpstreamSocket: () => fakeUpstreamSocket,
    openai: {
      apiKey: "test-key"
    }
  });

  if (sink.lifecycleFactory === undefined) {
    throw new Error("Expected websocket lifecycle factory to be captured.");
  }

  const lifecycle = sink.lifecycleFactory({});

  // Act
  lifecycle.onOpen({}, fakeClientSocket);
  lifecycle.onMessage(
    {
      data: new Blob(["hello"], { type: "text/plain" })
    },
    fakeClientSocket
  );

  // Assert
  expect(
    parseSentPayload(getPayloadAt(fakeClientSocket.sentPayloads, 0))
  ).toEqual({
    error: {
      message: "Client message must be valid UTF-8 text.",
      type: "runtime_proxy_error"
    },
    type: "error"
  });
});

test("runtime accepts array buffer client payloads", () => {
  // Arrange
  const app = new Hono();
  const fakeUpstreamSocket = new FakeUpstreamSocket();
  const fakeClientSocket = new FakeClientSocket();
  const sink: { lifecycleFactory?: (context: unknown) => Lifecycle } = {};

  registerRealtimeProxy(app, {
    createNodeWebSocket: () => createNodeWebSocketAdapterStub(sink),
    createUpstreamSocket: () => fakeUpstreamSocket,
    openai: { apiKey: "test-key" }
  });

  if (sink.lifecycleFactory === undefined) {
    throw new Error("Expected websocket lifecycle factory to be captured.");
  }

  const lifecycle = sink.lifecycleFactory({});
  lifecycle.onOpen({}, fakeClientSocket);
  fakeUpstreamSocket.emit("open");

  // Act
  const encoded = Buffer.from(
    JSON.stringify({ type: "response.cancel" }),
    "utf8"
  );
  lifecycle.onMessage(
    {
      data: encoded.buffer.slice(
        encoded.byteOffset,
        encoded.byteOffset + encoded.byteLength
      )
    },
    fakeClientSocket
  );

  // Assert
  expect(
    parseSentPayload(getPayloadAt(fakeUpstreamSocket.sentPayloads, 0))
  ).toEqual({
    type: "response.cancel"
  });
});

test("runtime handles client protocol validation errors", () => {
  // Arrange
  const app = new Hono();
  const fakeUpstreamSocket = new FakeUpstreamSocket();
  const fakeClientSocket = new FakeClientSocket();
  const sink: { lifecycleFactory?: (context: unknown) => Lifecycle } = {};

  registerRealtimeProxy(app, {
    createNodeWebSocket: () => createNodeWebSocketAdapterStub(sink),
    createUpstreamSocket: () => fakeUpstreamSocket,
    openai: {
      apiKey: "test-key"
    }
  });

  if (sink.lifecycleFactory === undefined) {
    throw new Error("Expected websocket lifecycle factory to be captured.");
  }

  const lifecycle = sink.lifecycleFactory({});

  // Act
  lifecycle.onOpen({}, fakeClientSocket);
  lifecycle.onMessage(
    {
      data: JSON.stringify({ type: "" })
    },
    fakeClientSocket
  );

  // Assert
  expect(
    parseSentPayload(getPayloadAt(fakeClientSocket.sentPayloads, 0))
  ).toEqual({
    error: {
      message: "Client message failed protocol validation.",
      type: "runtime_proxy_error"
    },
    type: "error"
  });
});

test("runtime can disable automatic response.create after tool success", () => {
  // Arrange
  const app = new Hono();
  const fakeUpstreamSocket = new FakeUpstreamSocket();
  const fakeClientSocket = new FakeClientSocket();
  const sink: { lifecycleFactory?: (context: unknown) => Lifecycle } = {};

  registerRealtimeProxy(app, {
    autoResponseAfterToolSuccess: false,
    createNodeWebSocket: () => createNodeWebSocketAdapterStub(sink),
    createUpstreamSocket: () => fakeUpstreamSocket,
    openai: {
      apiKey: "test-key"
    }
  });

  if (sink.lifecycleFactory === undefined) {
    throw new Error("Expected websocket lifecycle factory to be captured.");
  }

  const lifecycle = sink.lifecycleFactory({});

  // Act
  lifecycle.onOpen({}, fakeClientSocket);
  fakeUpstreamSocket.emit("open");
  lifecycle.onMessage(
    {
      data: JSON.stringify({
        callId: "call_no_continue",
        output: { ok: true },
        type: "runtime.tool.success"
      })
    },
    fakeClientSocket
  );

  // Assert
  expect(fakeUpstreamSocket.sentPayloads).toHaveLength(1);
  expect(
    parseSentPayload(getPayloadAt(fakeUpstreamSocket.sentPayloads, 0)).type
  ).toBe("conversation.item.create");
});

test("runtime onClose closes both upstream and client sockets", () => {
  // Arrange
  const app = new Hono();
  const fakeUpstreamSocket = new FakeUpstreamSocket();
  const fakeClientSocket = new FakeClientSocket();
  const sink: { lifecycleFactory?: (context: unknown) => Lifecycle } = {};

  registerRealtimeProxy(app, {
    createNodeWebSocket: () => createNodeWebSocketAdapterStub(sink),
    createUpstreamSocket: () => fakeUpstreamSocket,
    openai: { apiKey: "test-key" }
  });

  if (sink.lifecycleFactory === undefined) {
    throw new Error("Expected websocket lifecycle factory to be captured.");
  }

  const lifecycle = sink.lifecycleFactory({});

  // Act
  lifecycle.onClose({}, fakeClientSocket);

  // Assert
  expect(fakeUpstreamSocket.closeCalls).toHaveLength(1);
  expect(fakeClientSocket.closeCalls).toHaveLength(1);
});

test("runtime handles upstream invalid JSON and non-text payloads", () => {
  // Arrange
  const app = new Hono();
  const fakeUpstreamSocket = new FakeUpstreamSocket();
  const fakeClientSocket = new FakeClientSocket();
  const sink: { lifecycleFactory?: (context: unknown) => Lifecycle } = {};

  registerRealtimeProxy(app, {
    createNodeWebSocket: () => createNodeWebSocketAdapterStub(sink),
    createUpstreamSocket: () => fakeUpstreamSocket,
    openai: { apiKey: "test-key" }
  });

  if (sink.lifecycleFactory === undefined) {
    throw new Error("Expected websocket lifecycle factory to be captured.");
  }

  const lifecycle = sink.lifecycleFactory({});
  lifecycle.onOpen({}, fakeClientSocket);
  fakeUpstreamSocket.emit("open");

  // Act
  fakeUpstreamSocket.emit("message", "not-json");
  fakeUpstreamSocket.emit("message", [Buffer.from("a"), Buffer.from("b")]);
  fakeUpstreamSocket.emit("message", Buffer.from("[]", "utf8"));
  fakeUpstreamSocket.emit("message", 123);

  // Assert
  expect(
    parseSentPayload(getPayloadAt(fakeClientSocket.sentPayloads, 0))
  ).toEqual({
    error: {
      message: "Received invalid JSON from upstream.",
      type: "runtime_proxy_error"
    },
    type: "error"
  });
  expect(
    parseSentPayload(getPayloadAt(fakeClientSocket.sentPayloads, 1))
  ).toEqual({
    error: {
      message: "Received invalid JSON from upstream.",
      type: "runtime_proxy_error"
    },
    type: "error"
  });
  expect(
    parseSentPayload(getPayloadAt(fakeClientSocket.sentPayloads, 2))
  ).toEqual({
    error: {
      message: "Received invalid JSON from upstream.",
      type: "runtime_proxy_error"
    },
    type: "error"
  });
  expect(
    parseSentPayload(getPayloadAt(fakeClientSocket.sentPayloads, 3))
  ).toEqual({
    error: {
      message: "Received non-text upstream payload.",
      type: "runtime_proxy_error"
    },
    type: "error"
  });
});

test("runtime logs upstream error and transport error details", () => {
  // Arrange
  const app = new Hono();
  const fakeUpstreamSocket = new FakeUpstreamSocket();
  const fakeClientSocket = new FakeClientSocket();
  const sink: { lifecycleFactory?: (context: unknown) => Lifecycle } = {};
  const logs: Array<{ message: string; details?: Record<string, unknown> }> =
    [];

  registerRealtimeProxy(app, {
    createNodeWebSocket: () => createNodeWebSocketAdapterStub(sink),
    createUpstreamSocket: () => fakeUpstreamSocket,
    onLog: (message, details) => {
      if (details === undefined) {
        logs.push({ message });
      } else {
        logs.push({ details, message });
      }
    },
    openai: { apiKey: "test-key" }
  });

  if (sink.lifecycleFactory === undefined) {
    throw new Error("Expected websocket lifecycle factory to be captured.");
  }

  const lifecycle = sink.lifecycleFactory({});
  lifecycle.onOpen({}, fakeClientSocket);
  fakeUpstreamSocket.emit("open");

  // Act
  fakeUpstreamSocket.emit("message", JSON.stringify({ type: "error" }));
  fakeUpstreamSocket.emit("error", new Error("boom"));
  fakeUpstreamSocket.emit("error", "plain error");
  fakeUpstreamSocket.emit("error", { hello: "world" });
  fakeUpstreamSocket.emit("close", 1001, Buffer.from("bye"));

  // Assert
  expect(logs.some((entry) => entry.message === "runtime.upstream.error")).toBe(
    true
  );
  expect(
    logs.some(
      (entry) =>
        entry.message === "runtime.upstream.transport_error" &&
        entry.details?.error === "Unknown error"
    )
  ).toBe(true);
  expect(fakeClientSocket.closeCalls.some((entry) => entry.code === 1001)).toBe(
    true
  );
});

test("runtime handles upstream error before client onOpen wiring", () => {
  // Arrange
  const app = new Hono();
  const fakeUpstreamSocket = new FakeUpstreamSocket();
  const sink: { lifecycleFactory?: (context: unknown) => Lifecycle } = {};
  const logs: string[] = [];

  registerRealtimeProxy(app, {
    createNodeWebSocket: () => createNodeWebSocketAdapterStub(sink),
    createUpstreamSocket: () => fakeUpstreamSocket,
    onLog: (message) => {
      logs.push(message);
    },
    openai: { apiKey: "test-key" }
  });

  if (sink.lifecycleFactory === undefined) {
    throw new Error("Expected websocket lifecycle factory to be captured.");
  }

  // Act
  sink.lifecycleFactory({});
  fakeUpstreamSocket.emit("error", new Error("upstream failed early"));

  // Assert
  expect(logs).toContain("runtime.upstream.transport_error");
});
