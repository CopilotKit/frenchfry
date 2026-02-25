import { cors } from "hono/cors";
import { Hono } from "hono";
import { serve, type ServerType } from "@hono/node-server";
import {
  RUNTIME_PACKAGE_NAME,
  registerRealtimeProxy,
  type RealtimeProxyRegistration,
  type RuntimeRealtimeProxyOptions
} from "@frenchfryai/runtime";
import { z } from "zod";

export const SERVER_DEMO_NAME = "@frenchfryai/demo-server";

type OpenAiConfig = {
  apiKey: string;
  baseUrl?: string;
  model: string;
  organization?: string;
  project?: string;
};

/**
 * Represents validated demo server configuration.
 */
export type DemoServerConfig = {
  appOrigin: string;
  host: string;
  openai: OpenAiConfig;
  port: number;
  proxyPath: string;
};

/**
 * Represents optional runtime wiring overrides for tests and custom bootstrapping.
 */
export type DemoServerAppOptions = {
  autoResponseAfterToolSuccess?: boolean;
  createNodeWebSocket?: RuntimeRealtimeProxyOptions["createNodeWebSocket"];
  createUpstreamSocket?: RuntimeRealtimeProxyOptions["createUpstreamSocket"];
  onLog?: RuntimeRealtimeProxyOptions["onLog"];
};

/**
 * Represents the created Hono app and websocket registration details.
 */
export type DemoServerAppRegistration = RealtimeProxyRegistration & {
  app: Hono;
  packageName: string;
};

/**
 * Represents a running demo server process.
 */
export type DemoServerHandle = {
  close: () => Promise<void>;
  server: ServerType;
};

const environmentSchema = z.object({
  DEMO_APP_ORIGIN: z.string().url().default("http://localhost:5173"),
  DEMO_SERVER_HOST: z.string().min(1).default("0.0.0.0"),
  DEMO_SERVER_PORT: z.coerce.number().int().min(1).max(65535).default(8787),
  OPENAI_API_KEY: z.string().min(1),
  OPENAI_ORGANIZATION: z.string().min(1).optional(),
  OPENAI_PROJECT: z.string().min(1).optional(),
  OPENAI_REALTIME_BASE_URL: z.string().url().optional(),
  OPENAI_REALTIME_MODEL: z.string().min(1).default("gpt-realtime"),
  REALTIME_PROXY_PATH: z.string().startsWith("/").default("/realtime/ws")
});

/**
 * Validates and resolves demo server config from process environment.
 *
 * @param environment Raw environment object from process boundary.
 * @returns Validated, typed configuration for the demo server.
 * @throws Error when required values are missing or malformed.
 */
export const resolveDemoServerConfig = (
  environment: Readonly<Record<string, string | undefined>>
): DemoServerConfig => {
  const parsedEnvironment = environmentSchema.safeParse(environment);

  if (!parsedEnvironment.success) {
    const details = parsedEnvironment.error.issues
      .map((issue) => {
        return `${issue.path.join(".")}: ${issue.message}`;
      })
      .join("; ");
    throw new Error(`Invalid demo server environment: ${details}`);
  }

  const parsed = parsedEnvironment.data;

  const openAiConfig: OpenAiConfig = {
    apiKey: parsed.OPENAI_API_KEY,
    model: parsed.OPENAI_REALTIME_MODEL,
    ...(parsed.OPENAI_ORGANIZATION === undefined
      ? {}
      : {
          organization: parsed.OPENAI_ORGANIZATION
        }),
    ...(parsed.OPENAI_PROJECT === undefined
      ? {}
      : {
          project: parsed.OPENAI_PROJECT
        }),
    ...(parsed.OPENAI_REALTIME_BASE_URL === undefined
      ? {}
      : {
          baseUrl: parsed.OPENAI_REALTIME_BASE_URL
        })
  };

  return {
    appOrigin: parsed.DEMO_APP_ORIGIN,
    host: parsed.DEMO_SERVER_HOST,
    openai: openAiConfig,
    port: parsed.DEMO_SERVER_PORT,
    proxyPath: parsed.REALTIME_PROXY_PATH
  };
};

/**
 * Creates the Hono demo server app and registers the runtime realtime proxy.
 *
 * @param config Validated server configuration.
 * @param options Optional runtime adapter overrides.
 * @returns App instance and websocket registration details.
 */
export const createDemoServerApp = (
  config: DemoServerConfig,
  options: DemoServerAppOptions = {}
): DemoServerAppRegistration => {
  const app = new Hono();

  app.use(
    "/config",
    cors({
      origin: config.appOrigin
    })
  );

  app.get("/health", (context) => {
    return context.json({
      ok: true,
      packageName: SERVER_DEMO_NAME,
      runtimePackageName: RUNTIME_PACKAGE_NAME
    });
  });

  app.get("/config", (context) => {
    return context.json({
      realtimeWebSocketUrl: resolveRealtimeWebSocketUrl(
        context.req.url,
        config.proxyPath
      )
    });
  });

  const registration = registerRealtimeProxy(app, {
    ...(options.autoResponseAfterToolSuccess === undefined
      ? {}
      : {
          autoResponseAfterToolSuccess: options.autoResponseAfterToolSuccess
        }),
    ...(options.createNodeWebSocket === undefined
      ? {}
      : {
          createNodeWebSocket: options.createNodeWebSocket
        }),
    ...(options.createUpstreamSocket === undefined
      ? {}
      : {
          createUpstreamSocket: options.createUpstreamSocket
        }),
    ...(options.onLog === undefined
      ? {}
      : {
          onLog: options.onLog
        }),
    openai: {
      apiKey: config.openai.apiKey,
      includeBetaHeader: true,
      model: config.openai.model,
      ...(config.openai.baseUrl === undefined
        ? {}
        : {
            baseUrl: config.openai.baseUrl
          }),
      ...(config.openai.organization === undefined
        ? {}
        : {
            organization: config.openai.organization
          }),
      ...(config.openai.project === undefined
        ? {}
        : {
            project: config.openai.project
          })
    },
    path: config.proxyPath
  });

  return {
    app,
    injectWebSocket: registration.injectWebSocket,
    packageName: SERVER_DEMO_NAME,
    path: registration.path
  };
};

/**
 * Starts the demo server HTTP process and injects websocket handling.
 *
 * @param config Validated server configuration.
 * @param options Optional runtime adapter overrides.
 * @returns Running server handle.
 */
/* c8 ignore start */
export const startDemoServer = (
  config: DemoServerConfig,
  options: DemoServerAppOptions = {}
): DemoServerHandle => {
  const registration = createDemoServerApp(config, options);
  const server = serve({
    fetch: registration.app.fetch,
    hostname: config.host,
    port: config.port
  });
  registration.injectWebSocket(server);

  return {
    close: () => {
      return new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error === undefined) {
            resolve();
            return;
          }

          reject(error);
        });
      });
    },
    server
  };
};
/* c8 ignore stop */

/**
 * Resolves a websocket URL from a request URL and configured proxy path.
 *
 * @param requestUrl Absolute request URL.
 * @param proxyPath Proxy route path.
 * @returns Absolute websocket URL for demo clients.
 */
const resolveRealtimeWebSocketUrl = (
  requestUrl: string,
  proxyPath: string
): string => {
  const url = new URL(requestUrl);
  const websocketProtocol = url.protocol === "https:" ? "wss:" : "ws:";
  return `${websocketProtocol}//${url.host}${proxyPath}`;
};

/**
 * Determines whether this module is being run as the Node entrypoint.
 *
 * @param moduleUrl Current module URL.
 * @returns True when launched directly by Node.
 */
/* c8 ignore start */
const isMainModule = (moduleUrl: string): boolean => {
  const entryPath = process.argv.at(1);
  if (entryPath === undefined) {
    return false;
  }

  return new URL(`file://${entryPath}`).href === moduleUrl;
};
if (isMainModule(import.meta.url)) {
  const config = resolveDemoServerConfig(process.env);
  const registration = createDemoServerApp(config, {
    onLog: (message, details) => {
      const serializedDetails =
        details === undefined ? "" : ` ${JSON.stringify(details)}`;
      console.info(`[${SERVER_DEMO_NAME}] ${message}${serializedDetails}`);
    }
  });
  const server = serve({
    fetch: registration.app.fetch,
    hostname: config.host,
    port: config.port
  });
  registration.injectWebSocket(server);
  console.info(
    `[${SERVER_DEMO_NAME}] listening on http://${config.host}:${config.port}`
  );
  console.info(
    `[${SERVER_DEMO_NAME}] realtime websocket route ${registration.path}`
  );
}
/* c8 ignore stop */
