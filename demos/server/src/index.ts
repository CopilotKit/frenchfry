import { serve, type ServerType } from "@hono/node-server";
import {
  RUNTIME_PACKAGE_NAME,
  registerRealtimeSessionRoute,
  type RealtimeSessionRegistration,
  type RuntimeRealtimeSessionOptions
} from "@frenchfryai/runtime";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { z } from "zod";

export const SERVER_DEMO_NAME = "@frenchfryai/demo-server";

type OpenAiConfig = {
  apiKey: string;
  callsUrl?: string;
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
  sessionPath: string;
};

/**
 * Represents optional runtime wiring overrides for tests and custom bootstrapping.
 */
export type DemoServerAppOptions = {
  onLog?: RuntimeRealtimeSessionOptions["onLog"];
};

/**
 * Represents the created Hono app and session registration details.
 */
export type DemoServerAppRegistration = RealtimeSessionRegistration & {
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
  OPENAI_REALTIME_CALLS_URL: z.string().url().optional(),
  REALTIME_SESSION_PATH: z.string().startsWith("/").default("/realtime/session")
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
    ...(parsed.OPENAI_REALTIME_CALLS_URL === undefined
      ? {}
      : {
          callsUrl: parsed.OPENAI_REALTIME_CALLS_URL
        })
  };

  return {
    appOrigin: parsed.DEMO_APP_ORIGIN,
    host: parsed.DEMO_SERVER_HOST,
    openai: openAiConfig,
    port: parsed.DEMO_SERVER_PORT,
    sessionPath: parsed.REALTIME_SESSION_PATH
  };
};

/**
 * Creates the Hono demo server app and registers the runtime realtime session route.
 *
 * @param config Validated server configuration.
 * @param options Optional runtime adapter overrides.
 * @returns App instance and session registration details.
 */
export const createDemoServerApp = (
  config: DemoServerConfig,
  options: DemoServerAppOptions = {}
): DemoServerAppRegistration => {
  const app = new Hono();
  const corsOptions = {
    origin: config.appOrigin
  };

  app.use("/config", cors(corsOptions));
  app.use(config.sessionPath, cors(corsOptions));

  app.get("/health", (context) => {
    return context.json({
      ok: true,
      packageName: SERVER_DEMO_NAME,
      runtimePackageName: RUNTIME_PACKAGE_NAME
    });
  });

  app.get("/config", (context) => {
    return context.json({
      realtimeSessionUrl: resolveRealtimeSessionUrl(
        context.req.url,
        config.sessionPath
      )
    });
  });

  const registration = registerRealtimeSessionRoute(app, {
    ...(options.onLog === undefined
      ? {}
      : {
          onLog: options.onLog
        }),
    openai: {
      apiKey: config.openai.apiKey,
      ...(config.openai.callsUrl === undefined
        ? {}
        : {
            callsUrl: config.openai.callsUrl
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
    path: config.sessionPath
  });

  return {
    app,
    packageName: SERVER_DEMO_NAME,
    path: registration.path
  };
};

/**
 * Starts the demo server HTTP process.
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
 * Resolves an HTTP session URL from a request URL and configured path.
 *
 * @param requestUrl Absolute request URL.
 * @param sessionPath Session route path.
 * @returns Absolute HTTP URL for demo clients.
 */
const resolveRealtimeSessionUrl = (
  requestUrl: string,
  sessionPath: string
): string => {
  const url = new URL(requestUrl);
  const protocol = url.protocol === "https:" ? "https:" : "http:";
  return `${protocol}//${url.host}${sessionPath}`;
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
  serve({
    fetch: registration.app.fetch,
    hostname: config.host,
    port: config.port
  });
  console.info(
    `[${SERVER_DEMO_NAME}] listening on http://${config.host}:${config.port}`
  );
  console.info(
    `[${SERVER_DEMO_NAME}] realtime session route ${registration.path}`
  );
}
/* c8 ignore stop */
