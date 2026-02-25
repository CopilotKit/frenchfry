import { s, type Chat } from "@hashbrownai/core";
import {
  type OpenAIClientEvent,
  createFunctionCallOutputEvents,
  createRealtimeClient,
  createToolCallAccumulatorState,
  createToolRegistry,
  isErrorEvent,
  isFunctionCallArgumentsDeltaEvent,
  isFunctionCallArgumentsDoneEvent,
  reduceToolCallAccumulatorState,
  runToolInvocation,
  shouldInvokeToolCall,
  type CoreClientEvent,
  type CoreServerEvent,
  type ErrorEvent,
  type FunctionCallArgumentsDoneEvent,
  type OrchestrationTool,
  type ToolCallAccumulatorState
} from "@frenchfryai/core";
import {
  type Dispatch,
  type ReactNode,
  type SetStateAction,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState
} from "react";
import { Subscription } from "rxjs";

import { type GenUiRegistration } from "./use-gen-ui";
import {
  VoiceAgentContext,
  type ActiveToolCallState,
  type VoiceAgentRenderState
} from "./use-voice-agent";

/**
 * Represents props for the `VoiceAgent` orchestration component.
 */
export type VoiceAgentProps = {
  children: (agent: VoiceAgentRenderState) => ReactNode;
  genUi?: readonly GenUiRegistration[];
  session: {
    model: string;
    type: "realtime";
  } & Record<string, unknown>;
  sessionEndpoint: string;
  toolTimeoutMs?: number;
  tools?: readonly Chat.AnyTool[];
};

type SessionToolDefinition = {
  description: string;
  name: string;
  parameters: unknown;
  type: "function";
};

/**
 * Owns realtime WebRTC lifecycle, tool invocation loop, and render-prop state for voice sessions.
 *
 * @param props Voice agent configuration.
 * @returns Provider-wrapped render-prop output.
 */
export const VoiceAgent = (props: VoiceAgentProps): ReactNode => {
  const toolTimeoutMs = props.toolTimeoutMs ?? 15000;
  const sessionSignature = useMemo(() => {
    return JSON.stringify(props.session);
  }, [props.session]);
  const hashbrownSessionTools = useMemo<
    readonly SessionToolDefinition[]
  >(() => {
    return props.tools?.map(toSessionToolFromHashbrownTool) ?? [];
  }, [props.tools]);

  const hashbrownOrchestrationTools = useMemo<
    readonly OrchestrationTool[]
  >(() => {
    return props.tools?.map(toOrchestrationToolFromHashbrownTool) ?? [];
  }, [props.tools]);

  const genUiSessionTools = useMemo<readonly SessionToolDefinition[]>(() => {
    return props.genUi?.map((registration) => registration.sessionTool) ?? [];
  }, [props.genUi]);

  const genUiOrchestrationTools = useMemo(() => {
    return (
      props.genUi?.map((registration) => registration.orchestrationTool) ?? []
    );
  }, [props.genUi]);

  const realtimeClient = useMemo(() => {
    return createRealtimeClient({
      session: props.session,
      sessionEndpoint: props.sessionEndpoint
    });
  }, [props.sessionEndpoint, sessionSignature]);

  const toolRegistry = useMemo(() => {
    return createToolRegistry([
      ...genUiOrchestrationTools,
      ...hashbrownOrchestrationTools
    ]);
  }, [genUiOrchestrationTools, hashbrownOrchestrationTools]);

  const accumulatorStateRef = useRef<ToolCallAccumulatorState>(
    createToolCallAccumulatorState()
  );
  const toolNameByCallIdRef = useRef<Map<string, string>>(new Map());
  const genUiRegistrationsRef = useRef<
    readonly GenUiRegistration[] | undefined
  >(props.genUi);
  const executeToolCallRef = useRef<
    (event: FunctionCallArgumentsDoneEvent) => Promise<void>
  >(async () => {});

  useEffect(() => {
    genUiRegistrationsRef.current = props.genUi;
  }, [props.genUi]);

  const [activeCallsById, setActiveCallsById] = useState<
    Readonly<Record<string, ActiveToolCallState>>
  >({});
  const [status, setStatus] = useState<
    "connecting" | "error" | "idle" | "running" | "stopping"
  >("idle");
  const [voiceInputStatus, setVoiceInputStatus] = useState<
    "idle" | "recording" | "unsupported"
  >("idle");
  const [genUiToolsConfigured, setGenUiToolsConfigured] = useState(false);
  const [lastError, setLastError] = useState<
    | {
        message: string;
        type: string;
      }
    | undefined
  >(undefined);
  const remoteAudioElementRef = useRef<HTMLAudioElement | null>(null);

  /**
   * Applies a core server event to internal tracked tool-call state.
   *
   * @param updatedAtMs Event timestamp.
   * @param event Core server event.
   */
  const applyAccumulatorEvent = useCallback(
    (updatedAtMs: number, event: CoreServerEvent): void => {
      accumulatorStateRef.current = reduceToolCallAccumulatorState(
        accumulatorStateRef.current,
        event,
        updatedAtMs
      );

      if (
        !isFunctionCallArgumentsDeltaEvent(event) &&
        !isFunctionCallArgumentsDoneEvent(event)
      ) {
        return;
      }

      const callId = event.call_id;
      const entry = accumulatorStateRef.current.callsById[callId];
      if (entry === undefined) {
        return;
      }

      setActiveCallsById((previous) => {
        const existing = previous[callId];
        if (existing?.status === "running") {
          return previous;
        }
        const resolvedName =
          entry.name ?? toolNameByCallIdRef.current.get(callId);

        return {
          ...previous,
          [callId]: {
            argumentText: entry.argumentText,
            callId: entry.callId,
            itemId: entry.itemId,
            ...(resolvedName === undefined ? {} : { name: resolvedName }),
            responseId: entry.responseId,
            status: "streaming",
            updatedAtMs
          }
        };
      });
    },
    []
  );

  /**
   * Creates and caches an audio element for remote assistant speech.
   *
   * @returns Audio element, or `null` when DOM APIs are unavailable.
   */
  const ensureRemoteAudioElement = useCallback((): HTMLAudioElement | null => {
    if (remoteAudioElementRef.current !== null) {
      return remoteAudioElementRef.current;
    }

    if (typeof document === "undefined") {
      return null;
    }

    const audioElement = document.createElement("audio");
    audioElement.autoplay = true;
    audioElement.style.display = "none";
    document.body.appendChild(audioElement);
    remoteAudioElementRef.current = audioElement;
    return audioElement;
  }, []);

  /**
   * Removes remote audio element and clears active media binding.
   */
  const cleanupRemoteAudioElement = useCallback((): void => {
    const audioElement = remoteAudioElementRef.current;
    if (audioElement === null) {
      return;
    }

    audioElement.srcObject = null;
    audioElement.remove();
    remoteAudioElementRef.current = null;
  }, []);

  /**
   * Sends all generated client events through the active realtime client.
   *
   * @param events Client events to send.
   */
  const sendEvents = useCallback(
    (events: readonly CoreClientEvent[]): void => {
      for (const event of events) {
        realtimeClient.send(event);
      }
    },
    [realtimeClient]
  );

  useEffect(() => {
    if (status !== "running") {
      setGenUiToolsConfigured(false);
      return;
    }

    if (
      genUiToolsConfigured ||
      (genUiSessionTools.length === 0 && hashbrownSessionTools.length === 0)
    ) {
      return;
    }

    const existingSessionTools = extractSessionTools(props.session);
    const mergedTools = dedupeToolsByName([
      ...existingSessionTools,
      ...hashbrownSessionTools,
      ...genUiSessionTools
    ]);

    const sessionUpdateEvent = {
      session: {
        tools: mergedTools,
        type: "realtime"
      },
      type: "session.update"
    } satisfies OpenAIClientEvent;

    sendEvents([sessionUpdateEvent]);
    setGenUiToolsConfigured(true);
  }, [
    genUiSessionTools,
    hashbrownSessionTools,
    genUiToolsConfigured,
    props.session,
    sendEvents,
    status
  ]);

  /**
   * Refreshes the latest tool-execution closure consumed by long-lived subscriptions.
   */
  useEffect(() => {
    executeToolCallRef.current = async (
      event: FunctionCallArgumentsDoneEvent
    ): Promise<void> => {
      setActiveCallsById((previous) => {
        const existing = previous[event.call_id];

        if (existing === undefined) {
          return previous;
        }

        return {
          ...previous,
          [event.call_id]: {
            ...existing,
            ...(event.name === undefined ? {} : { name: event.name }),
            status: "running",
            updatedAtMs: Date.now()
          }
        };
      });

      const result = await runToolInvocation({
        doneEvent: event,
        timeoutMs: toolTimeoutMs,
        toolsByName: toolRegistry
      });

      const outputEvents = createFunctionCallOutputEvents({
        callId: result.callId,
        output: result.output
      });
      sendEvents(outputEvents);

      setActiveCallsById((previous) => {
        const remaining = { ...previous };
        delete remaining[event.call_id];
        return remaining;
      });
      toolNameByCallIdRef.current.delete(event.call_id);
    };
  }, [sendEvents, toolRegistry, toolTimeoutMs]);

  useEffect(() => {
    const subscription = new Subscription();

    subscription.add(
      realtimeClient.toolCallStarts$.subscribe((start) => {
        genUiRegistrationsRef.current?.forEach((registration) => {
          registration.onToolCallStart({
            callId: start.callId
          });
        });

        subscription.add(
          start.argumentChunks$.subscribe((delta) => {
            genUiRegistrationsRef.current?.forEach((registration) => {
              registration.onToolCallDelta({
                callId: start.callId,
                delta
              });
            });
          })
        );
      })
    );

    subscription.add(
      realtimeClient.remoteAudioStream$.subscribe((stream) => {
        const audioElement = ensureRemoteAudioElement();
        if (audioElement === null) {
          return;
        }

        audioElement.srcObject = stream;
        void audioElement.play().catch((error: unknown) => {
          setLastError({
            message: toErrorMessage(error),
            type: "audio_playback_error"
          });
        });
      })
    );

    subscription.add(
      realtimeClient.events$.subscribe((event) => {
        const updatedAtMs = Date.now();
        const shouldExecuteDoneEvent = isFunctionCallArgumentsDoneEvent(event)
          ? shouldInvokeToolCall(accumulatorStateRef.current, event)
          : false;

        applyAccumulatorEvent(updatedAtMs, event);

        if (event.type === "runtime.connection.open") {
          setStatus("running");
          return;
        }

        if (event.type === "runtime.connection.closed") {
          toolNameByCallIdRef.current.clear();
          setVoiceInputStatus("idle");
          setStatus("idle");
          return;
        }

        if (isErrorEvent(event)) {
          handleErrorEvent(setLastError, setStatus, event);
          return;
        }

        const metadata = extractFunctionCallMetadata(event);
        if (metadata !== null) {
          toolNameByCallIdRef.current.set(metadata.callId, metadata.name);
          setActiveCallsById((previous) => {
            const existing = previous[metadata.callId];
            if (existing === undefined || existing.name === metadata.name) {
              return previous;
            }

            return {
              ...previous,
              [metadata.callId]: {
                ...existing,
                name: metadata.name
              }
            };
          });
          return;
        }

        if (isFunctionCallArgumentsDoneEvent(event)) {
          debugToolLoopReact("done event observed", {
            callId: event.call_id,
            name: event.name,
            shouldExecute: shouldExecuteDoneEvent
          });
          if (!shouldExecuteDoneEvent) {
            return;
          }

          genUiRegistrationsRef.current?.forEach((registration) => {
            registration.onToolCallDone(
              event.name === undefined
                ? {
                    callId: event.call_id
                  }
                : {
                    callId: event.call_id,
                    name: event.name
                  }
            );
          });

          void executeToolCallRef.current(event);
          return;
        }

        const outputItemDoneEvent = toDoneEventFromOutputItemDone(
          event,
          accumulatorStateRef.current,
          toolNameByCallIdRef.current
        );
        if (outputItemDoneEvent === null) {
          return;
        }

        const shouldExecuteOutputItemDone = shouldInvokeToolCall(
          accumulatorStateRef.current,
          outputItemDoneEvent
        );
        applyAccumulatorEvent(updatedAtMs, outputItemDoneEvent);
        debugToolLoopReact("output_item.done mapped to done", {
          callId: outputItemDoneEvent.call_id,
          name: outputItemDoneEvent.name,
          shouldExecute: shouldExecuteOutputItemDone
        });
        if (!shouldExecuteOutputItemDone) {
          return;
        }

        genUiRegistrationsRef.current?.forEach((registration) => {
          registration.onToolCallDone(
            outputItemDoneEvent.name === undefined
              ? {
                  callId: outputItemDoneEvent.call_id
                }
              : {
                  callId: outputItemDoneEvent.call_id,
                  name: outputItemDoneEvent.name
                }
          );
        });

        void executeToolCallRef.current(outputItemDoneEvent);
      })
    );

    return (): void => {
      subscription.unsubscribe();
    };
  }, [applyAccumulatorEvent, ensureRemoteAudioElement, realtimeClient]);

  useEffect(() => {
    return (): void => {
      realtimeClient.disconnect();
      cleanupRemoteAudioElement();
    };
  }, [cleanupRemoteAudioElement, realtimeClient]);

  /**
   * Starts the voice agent realtime session.
   */
  const start = useCallback((): void => {
    setLastError(undefined);
    setStatus("connecting");
    void realtimeClient.connect().catch((error: unknown) => {
      setLastError({
        message: toErrorMessage(error),
        type: "voice_connection_error"
      });
      setStatus("error");
    });
  }, [realtimeClient]);

  /**
   * Enables microphone capture by toggling the WebRTC local audio track.
   */
  const startVoiceInput = useCallback(async (): Promise<void> => {
    if (status !== "running") {
      setLastError({
        message: "Cannot start voice input before connection is running.",
        type: "voice_input_error"
      });
      return;
    }

    if (voiceInputStatus === "recording") {
      return;
    }

    await realtimeClient.setMicrophoneEnabled(true);
    setVoiceInputStatus("recording");
  }, [realtimeClient, status, voiceInputStatus]);

  /**
   * Disables microphone capture by muting local audio track.
   *
   * @param options Stop behavior options.
   */
  const stopVoiceInput = useCallback(
    (options?: { commit?: boolean }): void => {
      void options;
      if (voiceInputStatus !== "recording") {
        return;
      }

      void realtimeClient.setMicrophoneEnabled(false);
      setVoiceInputStatus("idle");
    },
    [realtimeClient, voiceInputStatus]
  );

  /**
   * Stops the voice agent realtime session.
   */
  const stop = useCallback((): void => {
    stopVoiceInput({
      commit: false
    });
    setStatus("stopping");
    realtimeClient.disconnect();
    setActiveCallsById({});
    accumulatorStateRef.current = createToolCallAccumulatorState();
    toolNameByCallIdRef.current.clear();
    setStatus("idle");
  }, [realtimeClient, stopVoiceInput]);

  /**
   * Sends a client event to the runtime realtime session.
   *
   * @param event Event payload.
   */
  const sendEvent = useCallback(
    (
      event: {
        type: string;
      } & Record<string, unknown>
    ): void => {
      realtimeClient.send(event);
    },
    [realtimeClient]
  );

  const renderState = useMemo<VoiceAgentRenderState>(() => {
    return {
      activeToolCalls: Object.values(activeCallsById),
      isConnected: status === "running",
      isRunning: status === "running",
      ...(lastError === undefined ? {} : { lastError }),
      sendEvent,
      startVoiceInput,
      start,
      status,
      stopVoiceInput,
      stop,
      voiceInputStatus
    };
  }, [
    activeCallsById,
    lastError,
    sendEvent,
    start,
    startVoiceInput,
    status,
    stop,
    stopVoiceInput,
    voiceInputStatus
  ]);

  return (
    <VoiceAgentContext.Provider value={renderState}>
      {props.children(renderState)}
    </VoiceAgentContext.Provider>
  );
};

/**
 * Extracts any existing session tool definitions from a session payload.
 *
 * @param session Session payload from props.
 * @returns Parsed session tool list.
 */
const extractSessionTools = (
  session: VoiceAgentProps["session"]
): readonly SessionToolDefinition[] => {
  const tools = session.tools;
  if (!Array.isArray(tools)) {
    return [];
  }

  return tools.filter(isSessionToolDefinition);
};

/**
 * Determines whether an unknown value is a session tool definition.
 *
 * @param value Unknown value.
 * @returns True when value matches the session tool shape.
 */
const isSessionToolDefinition = (
  value: unknown
): value is SessionToolDefinition => {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  if (!("description" in value) || !("name" in value)) {
    return false;
  }

  if (!("parameters" in value) || !("type" in value)) {
    return false;
  }

  return (
    typeof value.description === "string" &&
    typeof value.name === "string" &&
    value.type === "function"
  );
};

/**
 * Deduplicates tools by name, keeping the last definition for each tool.
 *
 * @param tools Ordered tool list.
 * @returns Deduplicated list preserving last-wins semantics.
 */
const dedupeToolsByName = (
  tools: readonly SessionToolDefinition[]
): readonly SessionToolDefinition[] => {
  const byName = new Map<string, SessionToolDefinition>();

  for (const tool of tools) {
    byName.set(tool.name, tool);
  }

  return Array.from(byName.values());
};

/**
 * Converts a Hashbrown tool into a session tool definition for model visibility.
 *
 * @param tool Hashbrown tool.
 * @returns Session tool definition.
 */
const toSessionToolFromHashbrownTool = (
  tool: Chat.AnyTool
): SessionToolDefinition => {
  return {
    description: tool.description,
    name: tool.name,
    parameters: toRealtimeToolParameters(tool.schema),
    type: "function"
  };
};

/**
 * Normalizes hashbrown tool schema inputs into plain JSON Schema for Realtime.
 *
 * @param schema Tool schema input.
 * @returns JSON-serializable parameters payload.
 */
const toRealtimeToolParameters = (schema: Chat.AnyTool["schema"]): unknown => {
  if (s.isHashbrownType(schema)) {
    return s.toJsonSchema(schema);
  }

  if (s.isStandardJsonSchema(schema)) {
    return schema["~standard"].jsonSchema.input({
      target: "draft-07"
    });
  }

  return schema;
};

/**
 * Converts a Hashbrown tool into an orchestration tool for runtime execution.
 *
 * @param tool Hashbrown tool.
 * @returns Orchestration tool.
 */
const toOrchestrationToolFromHashbrownTool = (
  tool: Chat.AnyTool
): OrchestrationTool => {
  return {
    description: tool.description,
    handler: async (
      input: unknown,
      abortSignal: AbortSignal
    ): Promise<unknown> => {
      return tool.handler(input, abortSignal);
    },
    name: tool.name
  };
};

/**
 * Maps a core error event into render-state status and error fields.
 *
 * @param setLastError Last-error setter.
 * @param setStatus Status setter.
 * @param event Error event.
 */
const handleErrorEvent = (
  setLastError: Dispatch<
    SetStateAction<
      | {
          message: string;
          type: string;
        }
      | undefined
    >
  >,
  setStatus: Dispatch<
    SetStateAction<"connecting" | "error" | "idle" | "running" | "stopping">
  >,
  event: ErrorEvent
): void => {
  setLastError({
    message: event.error.message,
    type: event.error.type
  });
  setStatus("error");
};

/**
 * Converts unknown errors to user-facing string messages.
 *
 * @param error Unknown error input.
 * @returns Readable error message.
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

/**
 * Extracts function-call metadata from pass-through output-item-added events.
 *
 * @param event Parsed core server event.
 * @returns Call metadata when event contains function-call name and call id.
 */
const extractFunctionCallMetadata = (
  event: CoreServerEvent
): { callId: string; name: string } | null => {
  if (event.type !== "response.output_item.added") {
    return null;
  }

  const item = event.item;
  if (typeof item !== "object" || item === null) {
    return null;
  }

  if (!("type" in item) || item.type !== "function_call") {
    return null;
  }

  if (!("call_id" in item) || typeof item.call_id !== "string") {
    return null;
  }

  if (!("name" in item) || typeof item.name !== "string") {
    return null;
  }

  return {
    callId: item.call_id,
    name: item.name
  };
};

/**
 * Creates a done event from `response.output_item.done` when possible.
 *
 * @param event Parsed core server event.
 * @param accumulatorState Current tool-call accumulator state.
 * @param toolNameByCallId Known call-id to tool-name mapping.
 * @returns Done event for invocation, or `null` when event does not contain usable completion metadata.
 */
const toDoneEventFromOutputItemDone = (
  event: CoreServerEvent,
  accumulatorState: ToolCallAccumulatorState,
  toolNameByCallId: ReadonlyMap<string, string>
): FunctionCallArgumentsDoneEvent | null => {
  if (event.type !== "response.output_item.done") {
    return null;
  }

  const item = event.item;
  if (typeof item !== "object" || item === null) {
    return null;
  }

  if (!("type" in item) || item.type !== "function_call") {
    return null;
  }

  if (!("call_id" in item) || typeof item.call_id !== "string") {
    return null;
  }

  const accumulatorEntry = accumulatorState.callsById[item.call_id];
  const argumentsText = resolveOutputItemDoneArguments(item, accumulatorEntry);
  if (argumentsText === null) {
    return null;
  }

  const itemName =
    "name" in item && typeof item.name === "string" ? item.name : undefined;
  const resolvedName =
    itemName ?? accumulatorEntry?.name ?? toolNameByCallId.get(item.call_id);

  return {
    arguments: argumentsText,
    call_id: item.call_id,
    ...(accumulatorEntry?.itemId === undefined
      ? {}
      : { item_id: accumulatorEntry.itemId }),
    ...(resolvedName === undefined ? {} : { name: resolvedName }),
    ...(accumulatorEntry?.responseId === undefined
      ? {}
      : { response_id: accumulatorEntry.responseId }),
    type: "response.function_call_arguments.done"
  };
};

/**
 * Resolves argument text from an output-item done payload or prior accumulated deltas.
 *
 * @param item Output item object from event payload.
 * @param accumulatorEntry Existing accumulator entry for the call id.
 * @returns Serialized argument text, or `null` when no arguments are available.
 */
const resolveOutputItemDoneArguments = (
  item: Readonly<Record<string, unknown>>,
  accumulatorEntry: ToolCallAccumulatorState["callsById"][string] | undefined
): string | null => {
  const rawArguments = "arguments" in item ? item.arguments : undefined;
  if (typeof rawArguments === "string") {
    return rawArguments;
  }

  if (rawArguments !== undefined) {
    try {
      return JSON.stringify(rawArguments);
    } catch {
      return null;
    }
  }

  if (accumulatorEntry === undefined) {
    return null;
  }

  return accumulatorEntry.argumentText;
};

/**
 * Emits debug logs for React-side tool-loop decisions when enabled.
 *
 * @param message Log message.
 * @param payload Optional structured payload.
 */
const debugToolLoopReact = (
  message: string,
  payload?: Readonly<Record<string, unknown>>
): void => {
  if (payload === undefined) {
    console.log("[frenchfry:react:tool-loop]", message);
    return;
  }

  console.log(
    "[frenchfry:react:tool-loop]",
    message,
    serializeDebugPayload(payload)
  );
};

/**
 * Safely serializes debug payloads for copy/paste logging.
 *
 * @param payload Debug payload object.
 * @returns JSON string representation.
 */
const serializeDebugPayload = (
  payload: Readonly<Record<string, unknown>>
): string => {
  try {
    return JSON.stringify(payload);
  } catch {
    return '{"serialization_error":true}';
  }
};
