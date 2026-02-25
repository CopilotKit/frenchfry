import {
  createFunctionCallOutputEvents,
  createRealtimeClient,
  createToolCallAccumulatorState,
  createToolRegistry,
  isErrorEvent,
  isFunctionCallArgumentsDeltaEvent,
  isFunctionCallArgumentsDoneEvent,
  reduceToolCallAccumulatorState,
  runToolInvocation,
  type CoreClientEvent,
  type CoreServerEvent,
  type ErrorEvent,
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

import {
  VoiceAgentContext,
  type ActiveToolCallState,
  type VoiceAgentRenderState
} from "./use-voice-agent";
import { type GenUiRegistration } from "./use-gen-ui";

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
  tools?: readonly OrchestrationTool[];
};

/**
 * Owns realtime WebRTC lifecycle, tool invocation loop, and render-prop state for voice sessions.
 *
 * @param props Voice agent configuration.
 * @returns Provider-wrapped render-prop output.
 */
export const VoiceAgent = (props: VoiceAgentProps): ReactNode => {
  const toolTimeoutMs = props.toolTimeoutMs ?? 15000;
  const realtimeClient = useMemo(() => {
    return createRealtimeClient({
      session: props.session,
      sessionEndpoint: props.sessionEndpoint
    });
  }, [props.session, props.sessionEndpoint]);

  const toolRegistry = useMemo(() => {
    return createToolRegistry(props.tools ?? []);
  }, [props.tools]);

  const accumulatorStateRef = useRef<ToolCallAccumulatorState>(
    createToolCallAccumulatorState()
  );

  const [activeCallsById, setActiveCallsById] = useState<
    Readonly<Record<string, ActiveToolCallState>>
  >({});
  const [status, setStatus] = useState<
    "connecting" | "error" | "idle" | "running" | "stopping"
  >("idle");
  const [voiceInputStatus, setVoiceInputStatus] = useState<
    "idle" | "recording" | "unsupported"
  >("idle");
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

        return {
          ...previous,
          [callId]: {
            argumentText: entry.argumentText,
            callId: entry.callId,
            itemId: entry.itemId,
            ...(entry.name === undefined ? {} : { name: entry.name }),
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

  /**
   * Executes a done tool call and sends its structured function-call-output response.
   *
   * @param event Done event payload.
   */
  const executeToolCall = useCallback(
    async (event: {
      arguments: string;
      call_id: string;
      item_id: string;
      name?: string;
      output_index: number;
      response_id: string;
      type: "response.function_call_arguments.done";
    }): Promise<void> => {
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
    },
    [sendEvents, toolRegistry, toolTimeoutMs]
  );

  useEffect(() => {
    const subscription = new Subscription();

    subscription.add(
      realtimeClient.toolCallStarts$.subscribe((start) => {
        props.genUi?.forEach((registration) => {
          registration.onToolCallStart({
            callId: start.callId
          });
        });
      })
    );

    subscription.add(
      realtimeClient.remoteAudioStream$.subscribe((stream) => {
        const audioElement = ensureRemoteAudioElement();
        if (audioElement === null) {
          return;
        }

        audioElement.srcObject = stream;
        void audioElement.play().catch(() => {
          return;
        });
      })
    );

    subscription.add(
      realtimeClient.events$.subscribe((event) => {
        const updatedAtMs = Date.now();

        applyAccumulatorEvent(updatedAtMs, event);

        if (event.type === "runtime.connection.open") {
          setStatus("running");
          return;
        }

        if (event.type === "runtime.connection.closed") {
          setVoiceInputStatus("idle");
          setStatus("idle");
          return;
        }

        if (isErrorEvent(event)) {
          handleErrorEvent(setLastError, setStatus, event);
          return;
        }

        if (isFunctionCallArgumentsDeltaEvent(event)) {
          props.genUi?.forEach((registration) => {
            registration.onToolCallDelta({
              callId: event.call_id,
              delta: event.delta
            });
          });
          return;
        }

        if (isFunctionCallArgumentsDoneEvent(event)) {
          props.genUi?.forEach((registration) => {
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

          void executeToolCall(event);
        }
      })
    );

    return (): void => {
      subscription.unsubscribe();
    };
  }, [
    applyAccumulatorEvent,
    ensureRemoteAudioElement,
    executeToolCall,
    props.genUi,
    realtimeClient
  ]);

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
