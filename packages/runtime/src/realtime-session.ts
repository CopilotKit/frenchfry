/* v8 ignore file */
import type { Hono } from "hono";
import { z } from "zod";

const DEFAULT_PATH = "/realtime/session";
const DEFAULT_CALLS_URL = "https://api.openai.com/v1/realtime/calls";

const sessionConfigSchema = z
  .object({
    type: z.literal("realtime")
  })
  .catchall(z.unknown());

/**
 * Represents OpenAI configuration used by runtime session exchange.
 */
export type RuntimeOpenAIOptions = {
  apiKey: string;
  callsUrl?: string;
  organization?: string;
  project?: string;
};

/**
 * Represents configuration options for realtime session route registration.
 */
export type RuntimeRealtimeSessionOptions = {
  onLog?: (message: string, details?: Record<string, unknown>) => void;
  openai: RuntimeOpenAIOptions;
  path?: string;
};

/**
 * Represents result of registering realtime session route on a Hono app.
 */
export type RealtimeSessionRegistration = {
  path: string;
};

/**
 * Registers a realtime session endpoint in a Hono app for OpenAI WebRTC calls.
 *
 * @param app Target Hono app.
 * @param options Session route configuration.
 * @returns Registration details including effective path.
 */
export const registerRealtimeSessionRoute = (
  app: Hono,
  options: RuntimeRealtimeSessionOptions
): RealtimeSessionRegistration => {
  const path = options.path ?? DEFAULT_PATH;

  app.post(path, async (context) => {
    const formDataValidationResult = await validateSessionRequest(
      context.req.raw
    );
    if (!formDataValidationResult.ok) {
      return context.text(formDataValidationResult.errorMessage, {
        status: 400
      });
    }

    const sdpValidationResult = validateSdpBody(formDataValidationResult.sdp);
    if (!sdpValidationResult.ok) {
      return context.text(sdpValidationResult.errorMessage, {
        status: 400
      });
    }

    const callResult = await createOpenAiRealtimeCall({
      openai: options.openai,
      offerSdp: sdpValidationResult.offerSdp,
      session: formDataValidationResult.session
    });

    if (!callResult.ok) {
      logInfo(options, "runtime.session.call_failed", {
        message: callResult.errorMessage,
        status: callResult.status
      });
      return new Response(callResult.errorMessage, {
        status: callResult.status
      });
    }

    return new Response(callResult.answerSdp, {
      headers: {
        "content-type": "application/sdp"
      },
      status: 200
    });
  });

  return {
    path
  };
};

type SessionConfig = z.infer<typeof sessionConfigSchema>;

type OpenAiCallInput = {
  offerSdp: string;
  openai: RuntimeOpenAIOptions;
  session: SessionConfig;
};

type OpenAiCallResult =
  | {
      answerSdp: string;
      ok: true;
    }
  | {
      errorMessage: string;
      ok: false;
      status: number;
    };

/**
 * Validates and parses multipart session request payload.
 *
 * @param request Raw HTTP request.
 * @returns Parsed SDP/session values or validation error details.
 */
const validateSessionRequest = async (
  request: Request
): Promise<
  | {
      ok: true;
      sdp: string;
      session: SessionConfig;
    }
  | {
      errorMessage: string;
      ok: false;
    }
> => {
  const contentType = request.headers.get("content-type");
  if (contentType === null || !contentType.includes("multipart/form-data")) {
    return {
      errorMessage: "Request must use multipart/form-data.",
      ok: false
    };
  }

  try {
    const formData = await request.formData();
    const sdp = formData.get("sdp");
    const session = formData.get("session");

    if (typeof sdp !== "string") {
      return {
        errorMessage: "Missing sdp form field.",
        ok: false
      };
    }

    if (typeof session !== "string") {
      return {
        errorMessage: "Missing session form field.",
        ok: false
      };
    }

    const sessionValidationResult = validateSessionConfig(session);
    if (!sessionValidationResult.ok) {
      return sessionValidationResult;
    }

    return {
      ok: true,
      sdp,
      session: sessionValidationResult.session
    };
  } catch {
    return {
      errorMessage: "Failed to parse multipart session request.",
      ok: false
    };
  }
};

/**
 * Validates SDP offer body extracted from request payload.
 *
 * @param requestBody Raw SDP body text.
 * @returns Parsed SDP offer or validation error details.
 */
const validateSdpBody = (
  requestBody: string
):
  | {
      offerSdp: string;
      ok: true;
    }
  | {
      errorMessage: string;
      ok: false;
    } => {
  if (requestBody.length === 0) {
    return {
      errorMessage: "Missing SDP offer in request body.",
      ok: false
    };
  }

  return {
    offerSdp: requestBody,
    ok: true
  };
};

/**
 * Validates and parses session configuration encoded in request header.
 *
 * @param serializedSession Serialized JSON session string.
 * @returns Parsed session config or validation error details.
 */
const validateSessionConfig = (
  serializedSession: string
):
  | {
      ok: true;
      session: SessionConfig;
    }
  | {
      errorMessage: string;
      ok: false;
    } => {
  try {
    const parsed: unknown = JSON.parse(serializedSession);
    const result = sessionConfigSchema.safeParse(parsed);

    if (!result.success) {
      return {
        errorMessage: "Session config failed validation.",
        ok: false
      };
    }

    return {
      ok: true,
      session: result.data
    };
  } catch {
    return {
      errorMessage: "Session config must be valid JSON.",
      ok: false
    };
  }
};

/**
 * Creates an OpenAI realtime call by forwarding SDP and session config.
 *
 * @param input OpenAI call inputs.
 * @returns OpenAI answer SDP on success, otherwise structured failure details.
 */
const createOpenAiRealtimeCall = async (
  input: OpenAiCallInput
): Promise<OpenAiCallResult> => {
  const formData = new FormData();
  formData.set("sdp", input.offerSdp);
  formData.set("session", JSON.stringify(input.session));

  const requestHeaders = buildOpenAiRequestHeaders(input.openai);

  try {
    const response = await fetch(input.openai.callsUrl ?? DEFAULT_CALLS_URL, {
      body: formData,
      headers: requestHeaders,
      method: "POST"
    });

    const responseText = await response.text();

    if (!response.ok) {
      return {
        errorMessage: responseText,
        ok: false,
        status: response.status
      };
    }

    return {
      answerSdp: responseText,
      ok: true
    };
  } catch (error: unknown) {
    return {
      errorMessage: toErrorMessage(error),
      ok: false,
      status: 500
    };
  }
};

/**
 * Builds OpenAI request headers for realtime call creation.
 *
 * @param options OpenAI configuration.
 * @returns Header record for OpenAI HTTP request.
 */
const buildOpenAiRequestHeaders = (
  options: RuntimeOpenAIOptions
): Record<string, string> => {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${options.apiKey}`
  };

  if (options.organization !== undefined) {
    headers["OpenAI-Organization"] = options.organization;
  }

  if (options.project !== undefined) {
    headers["OpenAI-Project"] = options.project;
  }

  return headers;
};

/**
 * Emits informational logs via configured sink.
 *
 * @param options Runtime options.
 * @param message Log message.
 * @param details Optional structured detail fields.
 */
const logInfo = (
  options: RuntimeRealtimeSessionOptions,
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
