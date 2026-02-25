import {
  isFunctionCallArgumentsDeltaEvent,
  isFunctionCallArgumentsDoneEvent
} from "./protocol";
import type {
  CoreClientEvent,
  CoreServerEvent,
  FunctionCallArgumentsDeltaEvent,
  FunctionCallArgumentsDoneEvent,
  OpenAIClientEvent
} from "./types";

/**
 * Represents a tool-call stream tracked by the accumulator.
 */
export type ToolCallAccumulatorEntry = {
  argumentText: string;
  callId: string;
  doneArguments?: string;
  isDone: boolean;
  itemId: string;
  name?: string;
  responseId: string;
  updatedAtMs: number;
};

/**
 * Represents immutable accumulator state for active and completed tool calls.
 */
export type ToolCallAccumulatorState = {
  callsById: Readonly<Record<string, ToolCallAccumulatorEntry>>;
};

/**
 * Represents an internal tool definition for orchestration.
 */
export type OrchestrationTool = {
  description: string;
  handler: (input: unknown, abortSignal: AbortSignal) => Promise<unknown>;
  name: string;
};

/**
 * Represents structured function call output returned to the model.
 */
export type ToolOutputEnvelope = {
  data?: unknown;
  error?: {
    code?: string;
    message: string;
    type: "invalid_arguments" | "tool_error" | "tool_timeout" | "unknown_tool";
  };
  meta?: {
    toolName?: string;
    timeoutMs?: number;
  };
  ok: boolean;
};

/**
 * Represents the result of running a tool invocation.
 */
export type ToolInvocationResult = {
  callId: string;
  output: ToolOutputEnvelope;
  status:
    | "invalid_arguments"
    | "success"
    | "tool_error"
    | "tool_timeout"
    | "unknown_tool";
};

/**
 * Represents input required to invoke a tool from a final done event.
 */
export type ToolInvocationInput = {
  doneEvent: FunctionCallArgumentsDoneEvent;
  timeoutMs: number;
  toolsByName: ReadonlyMap<string, OrchestrationTool>;
};

/**
 * Creates an empty tool-call accumulator state.
 *
 * @returns Empty state.
 */
export const createToolCallAccumulatorState = (): ToolCallAccumulatorState => {
  return {
    callsById: {}
  };
};

/**
 * Reduces a single core server event into updated tool-call accumulator state.
 *
 * @param state Previous accumulator state.
 * @param event Core server event.
 * @param updatedAtMs Timestamp applied to changed records.
 * @returns Updated accumulator state.
 */
export const reduceToolCallAccumulatorState = (
  state: ToolCallAccumulatorState,
  event: CoreServerEvent,
  updatedAtMs: number
): ToolCallAccumulatorState => {
  if (isFunctionCallArgumentsDeltaEvent(event)) {
    return reduceDelta(state, event, updatedAtMs);
  }

  if (isFunctionCallArgumentsDoneEvent(event)) {
    return reduceDone(state, event, updatedAtMs);
  }

  return state;
};

/**
 * Creates a validated tool registry map keyed by tool name.
 *
 * @param tools Tools to index.
 * @returns Readonly map keyed by name.
 */
export const createToolRegistry = (
  tools: readonly OrchestrationTool[]
): ReadonlyMap<string, OrchestrationTool> => {
  const map = new Map<string, OrchestrationTool>();

  for (const tool of tools) {
    map.set(tool.name, tool);
  }

  return map;
};

/**
 * Executes a tool invocation from a done event with timeout and structured failures.
 *
 * @param input Invocation input.
 * @returns Structured invocation result without throwing.
 */
export const runToolInvocation = async (
  input: ToolInvocationInput
): Promise<ToolInvocationResult> => {
  const tool = input.toolsByName.get(input.doneEvent.name ?? "");

  if (tool === undefined) {
    return {
      callId: input.doneEvent.call_id,
      output: {
        error: {
          message: `No tool registered for "${input.doneEvent.name ?? "unknown"}".`,
          type: "unknown_tool"
        },
        ok: false
      },
      status: "unknown_tool"
    };
  }

  const parsedArguments = parseToolArguments(input.doneEvent.arguments);

  if (!parsedArguments.ok) {
    return {
      callId: input.doneEvent.call_id,
      output: {
        error: {
          message: parsedArguments.message,
          type: "invalid_arguments"
        },
        meta: {
          toolName: tool.name
        },
        ok: false
      },
      status: "invalid_arguments"
    };
  }

  const controller = new AbortController();
  const timeoutPromise = createTimeoutPromise(input.timeoutMs, controller);

  try {
    const result = await Promise.race([
      tool.handler(parsedArguments.value, controller.signal),
      timeoutPromise
    ]);

    return {
      callId: input.doneEvent.call_id,
      output: {
        data: result,
        meta: {
          toolName: tool.name
        },
        ok: true
      },
      status: "success"
    };
  } catch (error) {
    if (isTimeoutError(error)) {
      return {
        callId: input.doneEvent.call_id,
        output: {
          error: {
            message: `Tool "${tool.name}" timed out after ${input.timeoutMs}ms.`,
            type: "tool_timeout"
          },
          meta: {
            timeoutMs: input.timeoutMs,
            toolName: tool.name
          },
          ok: false
        },
        status: "tool_timeout"
      };
    }

    return {
      callId: input.doneEvent.call_id,
      output: {
        error: {
          message: toErrorMessage(error),
          type: "tool_error"
        },
        meta: {
          toolName: tool.name
        },
        ok: false
      },
      status: "tool_error"
    };
  } finally {
    controller.abort();
  }
};

/**
 * Creates OpenAI-compatible client events for a function-call output payload.
 *
 * @param input Output envelope details.
 * @returns Client events to send through the core realtime client.
 */
export const createFunctionCallOutputEvents = (input: {
  autoResponse?: boolean;
  callId: string;
  output: ToolOutputEnvelope;
}): readonly CoreClientEvent[] => {
  const functionCallOutputEvent = {
    item: {
      call_id: input.callId,
      output: JSON.stringify(input.output),
      type: "function_call_output"
    },
    type: "conversation.item.create"
  } satisfies OpenAIClientEvent;

  if (input.autoResponse === false) {
    return [functionCallOutputEvent];
  }

  const responseCreateEvent = {
    response: {},
    type: "response.create"
  } satisfies OpenAIClientEvent;

  return [functionCallOutputEvent, responseCreateEvent];
};

/**
 * Reduces a delta event into accumulator state.
 *
 * @param state Previous state.
 * @param event Delta event.
 * @param updatedAtMs Updated timestamp.
 * @returns Updated state.
 */
const reduceDelta = (
  state: ToolCallAccumulatorState,
  event: FunctionCallArgumentsDeltaEvent,
  updatedAtMs: number
): ToolCallAccumulatorState => {
  const previous = state.callsById[event.call_id];

  const nextBase = {
    argumentText: `${previous?.argumentText ?? ""}${event.delta}`,
    callId: event.call_id,
    isDone: previous?.isDone ?? false,
    itemId: event.item_id ?? previous?.itemId ?? event.call_id,
    responseId: event.response_id ?? previous?.responseId ?? "unknown_response",
    updatedAtMs
  };
  const next: ToolCallAccumulatorEntry = {
    ...nextBase,
    ...(previous?.doneArguments === undefined
      ? {}
      : { doneArguments: previous.doneArguments }),
    ...(previous?.name === undefined ? {} : { name: previous.name })
  };

  return {
    callsById: {
      ...state.callsById,
      [event.call_id]: next
    }
  };
};

/**
 * Reduces a done event into accumulator state.
 *
 * @param state Previous state.
 * @param event Done event.
 * @param updatedAtMs Updated timestamp.
 * @returns Updated state.
 */
const reduceDone = (
  state: ToolCallAccumulatorState,
  event: FunctionCallArgumentsDoneEvent,
  updatedAtMs: number
): ToolCallAccumulatorState => {
  const previous = state.callsById[event.call_id];

  const nextBase = {
    argumentText: previous?.argumentText ?? event.arguments,
    callId: event.call_id,
    doneArguments: event.arguments,
    isDone: true,
    itemId: event.item_id ?? previous?.itemId ?? event.call_id,
    responseId: event.response_id ?? previous?.responseId ?? "unknown_response",
    updatedAtMs
  };
  const next: ToolCallAccumulatorEntry = {
    ...nextBase,
    ...(event.name === undefined ? {} : { name: event.name })
  };

  return {
    callsById: {
      ...state.callsById,
      [event.call_id]: next
    }
  };
};

/**
 * Parses tool arguments from serialized JSON.
 *
 * @param serialized Serialized JSON string.
 * @returns Parsed value or parse failure details.
 */
const parseToolArguments = (
  serialized: string
):
  | {
      ok: true;
      value: unknown;
    }
  | {
      message: string;
      ok: false;
    } => {
  const trimmed = serialized.trim();

  if (trimmed === "") {
    return {
      ok: true,
      value: undefined
    };
  }

  try {
    const parsed: unknown = JSON.parse(trimmed);
    return {
      ok: true,
      value: parsed
    };
  } catch {
    return {
      message: "Tool arguments were not valid JSON.",
      ok: false
    };
  }
};

/**
 * Creates a timeout promise that rejects with a tagged timeout error.
 *
 * @param timeoutMs Timeout duration.
 * @param controller Abort controller for propagation.
 * @returns Promise that rejects on timeout.
 */
const createTimeoutPromise = (
  timeoutMs: number,
  controller: AbortController
): Promise<never> => {
  return new Promise((_, reject) => {
    const timeoutId = setTimeout(() => {
      controller.abort();
      reject(createTimeoutError());
    }, timeoutMs);

    controller.signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timeoutId);
      },
      {
        once: true
      }
    );
  });
};

/**
 * Creates a tagged timeout error for internal discrimination.
 *
 * @returns Timeout error object.
 */
const createTimeoutError = (): Error => {
  const timeoutError = new Error("Tool timed out");
  Object.defineProperty(timeoutError, "name", {
    configurable: true,
    enumerable: false,
    value: "ToolTimeoutError",
    writable: true
  });

  return timeoutError;
};

/**
 * Determines whether an unknown value is the internal timeout error.
 *
 * @param error Unknown error.
 * @returns True when error is timeout sentinel.
 */
const isTimeoutError = (error: unknown): boolean => {
  return error instanceof Error && error.name === "ToolTimeoutError";
};

/**
 * Converts unknown errors into a message for envelope output.
 *
 * @param error Unknown error.
 * @returns Human-readable message.
 */
const toErrorMessage = (error: unknown): string => {
  if (error instanceof Error && error.message.length > 0) {
    return error.message;
  }

  return "Tool execution failed.";
};
