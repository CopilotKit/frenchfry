import { expect, test } from "vitest";
import type {
  ClientSocket,
  RuntimeNodeWebSocketAdapter
} from "@frenchfryai/runtime";

import {
  SERVER_DEMO_NAME,
  createDemoServerApp,
  resolveDemoServerConfig
} from "../src/index";

type Lifecycle = {
  onClose: (event: unknown, socket: ClientSocket) => void;
  onMessage: (
    event: { data: string | ArrayBufferLike | Blob },
    socket: ClientSocket
  ) => void;
  onOpen: (event: unknown, socket: ClientSocket) => void;
};

/**
 * Creates a node websocket adapter stub for deterministic server tests.
 *
 * @returns Adapter instance compatible with runtime registration.
 */
const createNodeWebSocketAdapterStub = (): RuntimeNodeWebSocketAdapter => {
  return {
    injectWebSocket: () => {
      return;
    },
    upgradeWebSocket: (
      configure: (context: unknown) => Lifecycle
    ): ((context: unknown) => Response) => {
      void configure;
      return () => {
        return new Response("ok");
      };
    }
  };
};

test("resolveDemoServerConfig parses required and default env values", () => {
  // Arrange
  const input = {
    OPENAI_API_KEY: "test-key"
  };

  // Act
  const result = resolveDemoServerConfig(input);

  // Assert
  expect(result.port).toBe(8787);
  expect(result.host).toBe("0.0.0.0");
  expect(result.proxyPath).toBe("/realtime/ws");
  expect(result.openai.model).toBe("gpt-realtime");
  expect(result.openai.apiKey).toBe("test-key");
});

test("resolveDemoServerConfig supports explicit overrides", () => {
  // Arrange
  const input = {
    DEMO_APP_ORIGIN: "http://localhost:5174",
    DEMO_SERVER_HOST: "127.0.0.1",
    DEMO_SERVER_PORT: "9090",
    OPENAI_API_KEY: "test-key",
    OPENAI_ORGANIZATION: "org_123",
    OPENAI_PROJECT: "proj_123",
    OPENAI_REALTIME_BASE_URL: "wss://example.test/realtime",
    OPENAI_REALTIME_MODEL: "gpt-realtime-preview",
    REALTIME_PROXY_PATH: "/ws/demo"
  };

  // Act
  const result = resolveDemoServerConfig(input);

  // Assert
  expect(result.port).toBe(9090);
  expect(result.host).toBe("127.0.0.1");
  expect(result.proxyPath).toBe("/ws/demo");
  expect(result.appOrigin).toBe("http://localhost:5174");
  expect(result.openai.baseUrl).toBe("wss://example.test/realtime");
  expect(result.openai.model).toBe("gpt-realtime-preview");
  expect(result.openai.organization).toBe("org_123");
  expect(result.openai.project).toBe("proj_123");
});

test("resolveDemoServerConfig throws for invalid port", () => {
  // Arrange
  const input = {
    DEMO_SERVER_PORT: "0",
    OPENAI_API_KEY: "test-key"
  };

  // Act / Assert
  expect(() => {
    resolveDemoServerConfig(input);
  }).toThrow("DEMO_SERVER_PORT");
});

test("resolveDemoServerConfig throws for missing api key", () => {
  // Arrange
  const input = {};

  // Act / Assert
  expect(() => {
    resolveDemoServerConfig(input);
  }).toThrow("OPENAI_API_KEY");
});

test("createDemoServerApp exposes health and runtime config routes", async () => {
  // Arrange
  const config = resolveDemoServerConfig({
    OPENAI_API_KEY: "test-key"
  });
  const appRegistration = createDemoServerApp(config, {
    createUpstreamSocket: () => {
      throw new Error("Upstream socket should not be created by HTTP routes.");
    }
  });

  // Act
  const healthResponse = await appRegistration.app.request(
    "http://localhost/health"
  );
  const configResponse = await appRegistration.app.request(
    "http://localhost/config"
  );

  // Assert
  expect(appRegistration.path).toBe("/realtime/ws");
  expect(appRegistration.packageName).toBe(SERVER_DEMO_NAME);
  expect(healthResponse.status).toBe(200);
  expect(await healthResponse.json()).toEqual({
    ok: true,
    packageName: "@frenchfryai/demo-server",
    runtimePackageName: "@frenchfryai/runtime"
  });
  expect(configResponse.status).toBe(200);
  expect(await configResponse.json()).toEqual({
    realtimeWebSocketUrl: "ws://localhost/realtime/ws"
  });
});

test("createDemoServerApp resolves secure websocket URLs from https requests", async () => {
  // Arrange
  const config = resolveDemoServerConfig({
    OPENAI_API_KEY: "test-key"
  });
  const appRegistration = createDemoServerApp(config, {
    createUpstreamSocket: () => {
      throw new Error("Upstream socket should not be created by HTTP routes.");
    }
  });

  // Act
  const configResponse = await appRegistration.app.request(
    "https://voice.example.com/config"
  );

  // Assert
  expect(await configResponse.json()).toEqual({
    realtimeWebSocketUrl: "wss://voice.example.com/realtime/ws"
  });
});

test("createDemoServerApp accepts optional runtime and openai overrides", async () => {
  // Arrange
  const config = resolveDemoServerConfig({
    OPENAI_API_KEY: "test-key",
    OPENAI_ORGANIZATION: "org_123",
    OPENAI_PROJECT: "proj_123",
    OPENAI_REALTIME_BASE_URL: "wss://example.test/realtime"
  });
  const appRegistration = createDemoServerApp(config, {
    autoResponseAfterToolSuccess: false,
    createNodeWebSocket: createNodeWebSocketAdapterStub,
    createUpstreamSocket: () => {
      throw new Error("Upstream socket should not be created by HTTP routes.");
    },
    onLog: () => {
      return;
    }
  });

  // Act
  const healthResponse = await appRegistration.app.request(
    "http://localhost/health"
  );

  // Assert
  expect(healthResponse.status).toBe(200);
});
