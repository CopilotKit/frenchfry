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
  toolTimeoutMs?: number;
  tools?: readonly OrchestrationTool[];
  url: string;
};

/**
 * Owns realtime websocket lifecycle, tool invocation loop, and render-prop state for voice sessions.
 *
 * @param props Voice agent configuration.
 * @returns Provider-wrapped render-prop output.
 */
export const VoiceAgent = (props: VoiceAgentProps): ReactNode => {
  const toolTimeoutMs = props.toolTimeoutMs ?? 15000;
  const realtimeClient = useMemo(() => {
    return createRealtimeClient({
      url: props.url
    });
  }, [props.url]);

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
  const audioContextRef = useRef<AudioContext | null>(null);
  const audioSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const audioProcessorRef = useRef<ScriptProcessorNode | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const recordingActiveRef = useRef(false);
  const outputAudioContextRef = useRef<AudioContext | null>(null);
  const playbackQueueRef = useRef<Promise<void>>(Promise.resolve());

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
   * Releases active browser audio-capture resources.
   */
  const cleanupVoiceInputResources = useCallback((): void => {
    audioProcessorRef.current?.disconnect();
    audioSourceRef.current?.disconnect();

    mediaStreamRef.current?.getTracks().forEach((track) => {
      track.stop();
    });

    if (audioContextRef.current !== null) {
      void audioContextRef.current.close();
    }

    audioProcessorRef.current = null;
    audioSourceRef.current = null;
    mediaStreamRef.current = null;
    audioContextRef.current = null;
    recordingActiveRef.current = false;
  }, []);

  /**
   * Releases active browser audio-playback resources and resets playback queue ordering.
   */
  const cleanupVoiceOutputResources = useCallback((): void => {
    const outputAudioContext = outputAudioContextRef.current;
    if (outputAudioContext !== null) {
      void outputAudioContext.close();
    }
    outputAudioContextRef.current = null;
    playbackQueueRef.current = Promise.resolve();
  }, []);

  /**
   * Creates or reuses the output audio context used for assistant speech playback.
   *
   * @returns Output audio context or `null` when unsupported.
   */
  const ensureOutputAudioContext = useCallback((): AudioContext | null => {
    if (outputAudioContextRef.current !== null) {
      return outputAudioContextRef.current;
    }

    if (typeof AudioContext === "undefined") {
      return null;
    }

    const outputAudioContext = new AudioContext();
    outputAudioContextRef.current = outputAudioContext;
    return outputAudioContext;
  }, []);

  /**
   * Queues a PCM16 assistant audio chunk for sequential playback.
   *
   * @param input Audio chunk payload and sample-rate metadata.
   */
  const queueAssistantAudioChunk = useCallback(
    (input: { base64Audio: string; sampleRateHz: number }): void => {
      const outputAudioContext = ensureOutputAudioContext();
      if (outputAudioContext === null) {
        return;
      }

      const samples = decodePcm16Base64(input.base64Audio);
      if (samples.length === 0) {
        return;
      }

      playbackQueueRef.current = playbackQueueRef.current
        .then(async () => {
          const currentContext = outputAudioContextRef.current;
          if (currentContext === null) {
            return;
          }

          if (currentContext.state === "suspended") {
            await currentContext.resume();
          }

          await playMonoPcmChunk({
            audioContext: currentContext,
            samples,
            sampleRateHz: input.sampleRateHz
          });
        })
        .catch(() => {
          setLastError({
            message: "Assistant audio playback failed.",
            type: "voice_output_error"
          });
        });
    },
    [ensureOutputAudioContext]
  );

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
      realtimeClient.events$.subscribe((event) => {
        const updatedAtMs = Date.now();

        applyAccumulatorEvent(updatedAtMs, event);

        if (event.type === "runtime.connection.open") {
          setStatus("running");
          return;
        }

        if (event.type === "runtime.connection.closed") {
          cleanupVoiceInputResources();
          cleanupVoiceOutputResources();
          setVoiceInputStatus("idle");
          setStatus("idle");
          return;
        }

        if (isResponseAudioDeltaEvent(event)) {
          queueAssistantAudioChunk({
            base64Audio: event.delta,
            sampleRateHz: event.sample_rate_hz ?? 24000
          });
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
    cleanupVoiceInputResources,
    cleanupVoiceOutputResources,
    executeToolCall,
    props.genUi,
    queueAssistantAudioChunk,
    realtimeClient
  ]);

  useEffect(() => {
    return (): void => {
      cleanupVoiceInputResources();
      cleanupVoiceOutputResources();
      realtimeClient.disconnect();
    };
  }, [cleanupVoiceInputResources, cleanupVoiceOutputResources, realtimeClient]);

  /**
   * Starts the voice agent websocket session.
   */
  const start = useCallback((): void => {
    setLastError(undefined);
    setStatus("connecting");
    realtimeClient.connect();
  }, [realtimeClient]);

  /**
   * Starts microphone capture and streams PCM16 audio into the realtime session.
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

    if (
      typeof navigator === "undefined" ||
      navigator.mediaDevices === undefined ||
      navigator.mediaDevices.getUserMedia === undefined ||
      typeof AudioContext === "undefined"
    ) {
      setVoiceInputStatus("unsupported");
      setLastError({
        message: "Browser does not support required microphone APIs.",
        type: "voice_input_unsupported"
      });
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true
        }
      });
      const audioContext = new AudioContext();
      const sourceNode = audioContext.createMediaStreamSource(stream);
      const processorNode = audioContext.createScriptProcessor(4096, 1, 1);

      processorNode.onaudioprocess = (event): void => {
        if (!recordingActiveRef.current) {
          return;
        }

        const sourceSamples = event.inputBuffer.getChannelData(0);
        const downsampled = downsampleMonoPcm(
          sourceSamples,
          audioContext.sampleRate,
          16000
        );
        const base64Audio = encodePcm16Base64(downsampled);

        realtimeClient.send({
          audio: base64Audio,
          type: "input_audio_buffer.append"
        });
      };

      sourceNode.connect(processorNode);
      processorNode.connect(audioContext.destination);

      mediaStreamRef.current = stream;
      audioContextRef.current = audioContext;
      audioSourceRef.current = sourceNode;
      audioProcessorRef.current = processorNode;
      recordingActiveRef.current = true;
      setVoiceInputStatus("recording");
    } catch (error: unknown) {
      cleanupVoiceInputResources();
      setVoiceInputStatus("idle");
      setLastError({
        message: toErrorMessage(error),
        type: "voice_input_error"
      });
    }
  }, [cleanupVoiceInputResources, realtimeClient, status, voiceInputStatus]);

  /**
   * Stops microphone capture and optionally commits buffered input audio.
   *
   * @param options Stop behavior options.
   */
  const stopVoiceInput = useCallback(
    (options?: { commit?: boolean }): void => {
      if (voiceInputStatus !== "recording") {
        return;
      }

      cleanupVoiceInputResources();
      setVoiceInputStatus("idle");

      const commit = options?.commit ?? true;
      if (!commit || status !== "running") {
        return;
      }

      realtimeClient.send({
        type: "input_audio_buffer.commit"
      });
      realtimeClient.send({
        response: {
          modalities: ["audio", "text"]
        },
        type: "response.create"
      });
    },
    [cleanupVoiceInputResources, realtimeClient, status, voiceInputStatus]
  );

  /**
   * Stops the voice agent websocket session.
   */
  const stop = useCallback((): void => {
    stopVoiceInput({
      commit: false
    });
    cleanupVoiceOutputResources();
    setStatus("stopping");
    realtimeClient.disconnect();
    setActiveCallsById({});
    accumulatorStateRef.current = createToolCallAccumulatorState();
    setStatus("idle");
  }, [cleanupVoiceOutputResources, realtimeClient, stopVoiceInput]);

  /**
   * Sends a client event to the runtime websocket session.
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
 * Downsamples mono float32 PCM samples to a target sample rate.
 *
 * @param input Source mono samples.
 * @param sourceRate Source sample rate.
 * @param targetRate Target sample rate.
 * @returns Downsampled mono samples.
 */
const downsampleMonoPcm = (
  input: Float32Array,
  sourceRate: number,
  targetRate: number
): Float32Array => {
  if (sourceRate === targetRate) {
    return input;
  }

  const ratio = sourceRate / targetRate;
  const outputLength = Math.max(1, Math.floor(input.length / ratio));
  const output = new Float32Array(outputLength);
  let sourceIndex = 0;

  for (let outputIndex = 0; outputIndex < outputLength; outputIndex += 1) {
    const nextSourceIndex = Math.min(
      input.length,
      Math.floor((outputIndex + 1) * ratio)
    );

    let total = 0;
    let count = 0;
    while (sourceIndex < nextSourceIndex) {
      total += input[sourceIndex] ?? 0;
      count += 1;
      sourceIndex += 1;
    }

    output[outputIndex] = count === 0 ? 0 : total / count;
  }

  return output;
};

/**
 * Encodes mono float32 PCM samples into base64 PCM16 bytes.
 *
 * @param input Mono float32 samples in range [-1, 1].
 * @returns Base64-encoded PCM16 payload.
 */
const encodePcm16Base64 = (input: Float32Array): string => {
  const bytes = new Uint8Array(input.length * 2);

  input.forEach((sample, index) => {
    const clamped = Math.max(-1, Math.min(1, sample));
    const int16Value =
      clamped < 0 ? Math.round(clamped * 32768) : Math.round(clamped * 32767);
    const byteOffset = index * 2;
    bytes[byteOffset] = int16Value & 255;
    bytes[byteOffset + 1] = (int16Value >> 8) & 255;
  });

  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const chunk = bytes.subarray(offset, offset + chunkSize);
    binary += String.fromCharCode(...chunk);
  }

  return btoa(binary);
};

/**
 * Decodes base64 PCM16 mono bytes into float32 samples in range [-1, 1].
 *
 * @param base64Audio Base64-encoded PCM16 little-endian bytes.
 * @returns Decoded mono samples.
 */
const decodePcm16Base64 = (base64Audio: string): Float32Array => {
  if (base64Audio.length === 0) {
    return new Float32Array(0);
  }

  try {
    const bytes = decodeBase64Bytes(base64Audio);
    const sampleCount = Math.floor(bytes.length / 2);
    const output = new Float32Array(sampleCount);

    for (let sampleIndex = 0; sampleIndex < sampleCount; sampleIndex += 1) {
      const byteOffset = sampleIndex * 2;
      const lowByte = bytes[byteOffset] ?? 0;
      const highByte = bytes[byteOffset + 1] ?? 0;
      const value = (highByte << 8) | lowByte;
      const signed = value >= 0x8000 ? value - 0x10000 : value;
      output[sampleIndex] = Math.max(-1, Math.min(1, signed / 32768));
    }

    return output;
  } catch {
    return new Float32Array(0);
  }
};

/**
 * Decodes a base64 string into raw bytes for runtime-compatible environments.
 *
 * @param base64Text Base64 string.
 * @returns Decoded bytes.
 */
const decodeBase64Bytes = (base64Text: string): Uint8Array => {
  if (typeof atob === "function") {
    const binary = atob(base64Text);
    const bytes = new Uint8Array(binary.length);

    for (let byteIndex = 0; byteIndex < binary.length; byteIndex += 1) {
      bytes[byteIndex] = binary.charCodeAt(byteIndex);
    }

    return bytes;
  }

  if (typeof Buffer !== "undefined") {
    return Uint8Array.from(Buffer.from(base64Text, "base64"));
  }

  throw new Error("No base64 decoder is available in this runtime.");
};

/**
 * Plays a mono PCM chunk through an audio context and resolves after playback finishes.
 *
 * @param input Audio context, sample-rate, and mono sample data.
 * @returns Promise resolved when source playback ends.
 */
const playMonoPcmChunk = (input: {
  audioContext: AudioContext;
  sampleRateHz: number;
  samples: Float32Array;
}): Promise<void> => {
  return new Promise((resolve) => {
    const audioBuffer = input.audioContext.createBuffer(
      1,
      input.samples.length,
      input.sampleRateHz
    );
    const channelData = audioBuffer.getChannelData(0);
    channelData.set(input.samples);

    const sourceNode = input.audioContext.createBufferSource();
    sourceNode.buffer = audioBuffer;
    sourceNode.connect(input.audioContext.destination);
    sourceNode.onended = () => {
      sourceNode.disconnect();
      resolve();
    };
    sourceNode.start();
  });
};

/**
 * Type guard for assistant audio delta server events.
 *
 * @param event Core server event.
 * @returns `true` when the event is an audio delta.
 */
const isResponseAudioDeltaEvent = (
  event: CoreServerEvent
): event is {
  delta: string;
  sample_rate_hz?: number;
  type: "response.audio.delta";
} => {
  if (event.type !== "response.audio.delta") {
    return false;
  }

  if (!("delta" in event) || typeof event.delta !== "string") {
    return false;
  }

  if (
    "sample_rate_hz" in event &&
    event.sample_rate_hz !== undefined &&
    typeof event.sample_rate_hz !== "number"
  ) {
    return false;
  }

  return true;
};

/**
 * Converts unknown errors into a readable message.
 *
 * @param error Unknown error value.
 * @returns Message string.
 */
const toErrorMessage = (error: unknown): string => {
  if (error instanceof Error && error.message.length > 0) {
    return error.message;
  }

  return "Unknown voice input error.";
};
