import { Hono } from "hono";
import { expect, test } from "vitest";

import {
  RUNTIME_PACKAGE_NAME,
  parseRuntimeClientProtocolEvent,
  registerRealtimeSessionRoute
} from "../src/index";

/**
 * Creates a basic valid multipart request payload for realtime session exchange.
 *
 * @returns Multipart form payload with `sdp` and `session` fields.
 */
const createValidSessionPayload = (): FormData => {
  const formData = new FormData();
  formData.set("sdp", "v=0\r\no=- 0 0 IN IP4 127.0.0.1");
  formData.set(
    "session",
    JSON.stringify({
      model: "gpt-realtime",
      type: "realtime"
    })
  );
  return formData;
};

test("runtime package exposes a stable name marker", () => {
  // Arrange
  const expectedName = "@frenchfryai/runtime";

  // Act
  const actualName = RUNTIME_PACKAGE_NAME;

  // Assert
  expect(actualName).toBe(expectedName);
});

test("parseRuntimeClientProtocolEvent accepts valid pass-through events", () => {
  // Arrange
  const input = {
    response: {},
    type: "response.create"
  };

  // Act
  const parsed = parseRuntimeClientProtocolEvent(input);

  // Assert
  expect(parsed).toEqual(input);
});

test("parseRuntimeClientProtocolEvent rejects invalid payload", () => {
  // Arrange / Act / Assert
  expect(() => {
    parseRuntimeClientProtocolEvent({
      type: ""
    });
  }).toThrow("Client event is not a valid runtime protocol payload.");
});

test("registerRealtimeSessionRoute uses default route path", () => {
  // Arrange
  const app = new Hono();

  // Act
  const registration = registerRealtimeSessionRoute(app, {
    openai: {
      apiKey: "test-key"
    }
  });

  // Assert
  expect(registration.path).toBe("/realtime/session");
  expect(app.routes.some((route) => route.path === "/realtime/session")).toBe(
    true
  );
});

test("registerRealtimeSessionRoute uses custom route path", () => {
  // Arrange
  const app = new Hono();

  // Act
  const registration = registerRealtimeSessionRoute(app, {
    openai: {
      apiKey: "test-key"
    },
    path: "/custom/session"
  });

  // Assert
  expect(registration.path).toBe("/custom/session");
  expect(app.routes.some((route) => route.path === "/custom/session")).toBe(
    true
  );
});

test("realtime session route forwards multipart payload to OpenAI and returns answer sdp", async () => {
  // Arrange
  const app = new Hono();
  const originalFetch = globalThis.fetch;
  let authorizationHeader: string | null = null;
  let forwardedSdp: string | null = null;
  let forwardedSession: string | null = null;

  const mockedFetch: typeof fetch = (_input, init) => {
    authorizationHeader =
      init?.headers instanceof Headers
        ? init.headers.get("Authorization")
        : Array.isArray(init?.headers)
          ? new Headers(init?.headers).get("Authorization")
          : new Headers(init?.headers ?? {}).get("Authorization");

    if (!(init?.body instanceof FormData)) {
      throw new Error(
        "Expected OpenAI request body to be multipart form data."
      );
    }

    const sdp = init.body.get("sdp");
    const session = init.body.get("session");

    forwardedSdp = typeof sdp === "string" ? sdp : null;
    forwardedSession = typeof session === "string" ? session : null;

    return Promise.resolve(
      new Response("answer-sdp", {
        status: 200
      })
    );
  };

  Reflect.set(globalThis, "fetch", mockedFetch);

  registerRealtimeSessionRoute(app, {
    openai: {
      apiKey: "test-key"
    }
  });

  try {
    // Act
    const response = await app.request("http://localhost/realtime/session", {
      body: createValidSessionPayload(),
      method: "POST"
    });

    // Assert
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/sdp");
    expect(await response.text()).toBe("answer-sdp");
    expect(authorizationHeader).toBe("Bearer test-key");
    expect(forwardedSdp).toContain("v=0");
    if (forwardedSession === null) {
      throw new Error("Expected forwarded session payload.");
    }
    expect(JSON.parse(forwardedSession)).toEqual({
      model: "gpt-realtime",
      type: "realtime"
    });
  } finally {
    Reflect.set(globalThis, "fetch", originalFetch);
  }
});

test("realtime session route returns 400 for missing multipart content type", async () => {
  // Arrange
  const app = new Hono();
  registerRealtimeSessionRoute(app, {
    openai: {
      apiKey: "test-key"
    }
  });

  // Act
  const response = await app.request("http://localhost/realtime/session", {
    body: "v=0",
    headers: {
      "content-type": "application/sdp"
    },
    method: "POST"
  });

  // Assert
  expect(response.status).toBe(400);
  expect(await response.text()).toBe("Request must use multipart/form-data.");
});

test("realtime session route returns 400 for missing sdp field", async () => {
  // Arrange
  const app = new Hono();
  const payload = new FormData();
  payload.set(
    "session",
    JSON.stringify({ model: "gpt-realtime", type: "realtime" })
  );

  registerRealtimeSessionRoute(app, {
    openai: {
      apiKey: "test-key"
    }
  });

  // Act
  const response = await app.request("http://localhost/realtime/session", {
    body: payload,
    method: "POST"
  });

  // Assert
  expect(response.status).toBe(400);
  expect(await response.text()).toBe("Missing sdp form field.");
});

test("realtime session route returns 400 for invalid session payload", async () => {
  // Arrange
  const app = new Hono();
  const payload = new FormData();
  payload.set("sdp", "v=0");
  payload.set("session", "not json");

  registerRealtimeSessionRoute(app, {
    openai: {
      apiKey: "test-key"
    }
  });

  // Act
  const response = await app.request("http://localhost/realtime/session", {
    body: payload,
    method: "POST"
  });

  // Assert
  expect(response.status).toBe(400);
  expect(await response.text()).toBe("Session config must be valid JSON.");
});

test("realtime session route propagates OpenAI non-2xx response", async () => {
  // Arrange
  const app = new Hono();
  const originalFetch = globalThis.fetch;

  const mockedFetch: typeof fetch = () =>
    Promise.resolve(
      new Response("upstream failure", {
        status: 401
      })
    );

  Reflect.set(globalThis, "fetch", mockedFetch);

  registerRealtimeSessionRoute(app, {
    openai: {
      apiKey: "test-key"
    }
  });

  try {
    // Act
    const response = await app.request("http://localhost/realtime/session", {
      body: createValidSessionPayload(),
      method: "POST"
    });

    // Assert
    expect(response.status).toBe(401);
    expect(await response.text()).toBe("upstream failure");
  } finally {
    Reflect.set(globalThis, "fetch", originalFetch);
  }
});

test("realtime session route returns 500 on fetch failure and logs", async () => {
  // Arrange
  const app = new Hono();
  const logs: Array<{ details?: Record<string, unknown>; message: string }> =
    [];
  const originalFetch = globalThis.fetch;

  const mockedFetch: typeof fetch = () =>
    Promise.reject(new Error("network down"));

  Reflect.set(globalThis, "fetch", mockedFetch);

  registerRealtimeSessionRoute(app, {
    onLog: (message, details) => {
      if (details === undefined) {
        logs.push({ message });
        return;
      }
      logs.push({ details, message });
    },
    openai: {
      apiKey: "test-key"
    }
  });

  try {
    // Act
    const response = await app.request("http://localhost/realtime/session", {
      body: createValidSessionPayload(),
      method: "POST"
    });

    // Assert
    expect(response.status).toBe(500);
    expect(await response.text()).toBe("network down");
    expect(
      logs.some((entry) => entry.message === "runtime.session.call_failed")
    ).toBe(true);
  } finally {
    Reflect.set(globalThis, "fetch", originalFetch);
  }
});
