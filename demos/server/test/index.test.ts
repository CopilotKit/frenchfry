import { expect, test } from "vitest";

import {
  SERVER_DEMO_NAME,
  createDemoServerApp,
  resolveDemoServerConfig
} from "../src/index";

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
  expect(result.sessionPath).toBe("/realtime/session");
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
    OPENAI_REALTIME_CALLS_URL: "https://example.test/realtime/calls",
    REALTIME_SESSION_PATH: "/session/demo"
  };

  // Act
  const result = resolveDemoServerConfig(input);

  // Assert
  expect(result.port).toBe(9090);
  expect(result.host).toBe("127.0.0.1");
  expect(result.sessionPath).toBe("/session/demo");
  expect(result.appOrigin).toBe("http://localhost:5174");
  expect(result.openai.callsUrl).toBe("https://example.test/realtime/calls");
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
  const appRegistration = createDemoServerApp(config);

  // Act
  const healthResponse = await appRegistration.app.request(
    "http://localhost/health"
  );
  const configResponse = await appRegistration.app.request(
    "http://localhost/config"
  );

  // Assert
  expect(appRegistration.path).toBe("/realtime/session");
  expect(appRegistration.packageName).toBe(SERVER_DEMO_NAME);
  expect(healthResponse.status).toBe(200);
  expect(await healthResponse.json()).toEqual({
    ok: true,
    packageName: "@frenchfryai/demo-server",
    runtimePackageName: "@frenchfryai/runtime"
  });
  expect(configResponse.status).toBe(200);
  expect(await configResponse.json()).toEqual({
    realtimeSessionUrl: "http://localhost/realtime/session"
  });
});

test("createDemoServerApp resolves secure session URLs from https requests", async () => {
  // Arrange
  const config = resolveDemoServerConfig({
    OPENAI_API_KEY: "test-key"
  });
  const appRegistration = createDemoServerApp(config);

  // Act
  const configResponse = await appRegistration.app.request(
    "https://voice.example.com/config"
  );

  // Assert
  expect(await configResponse.json()).toEqual({
    realtimeSessionUrl: "https://voice.example.com/realtime/session"
  });
});

test("createDemoServerApp accepts optional log callback", async () => {
  // Arrange
  const config = resolveDemoServerConfig({
    OPENAI_API_KEY: "test-key",
    OPENAI_ORGANIZATION: "org_123",
    OPENAI_PROJECT: "proj_123",
    OPENAI_REALTIME_CALLS_URL: "https://example.test/realtime/calls"
  });
  const appRegistration = createDemoServerApp(config, {
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
