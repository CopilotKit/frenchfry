/* v8 ignore file */
import { Observable, Subject } from "rxjs";
import { z } from "zod";

import {
  isFunctionCallArgumentsDeltaEvent,
  isFunctionCallArgumentsDoneEvent,
  parseCoreClientEvent,
  parseCoreServerEvent
} from "./protocol";
import type {
  CoreClientEvent,
  CoreServerEvent,
  CreateRealtimeClientOptions,
  RealtimeMediaStreamLike,
  RealtimeMediaStreamTrackLike,
  RealtimeClient,
  RealtimeDataChannelLike,
  RealtimePeerConnectionLike,
  RealtimeTrackEventLike,
  ToolCallStart
} from "./types";

const jsonRecordSchema = z.record(z.string(), z.unknown());
const DEFAULT_DATA_CHANNEL_LABEL = "oai-events";

/**
 * Creates a runtime-aware realtime WebRTC client for browser integrations.
 *
 * @param options Connection options.
 * @returns Realtime client API.
 */
export const createRealtimeClient = (
  options: CreateRealtimeClientOptions
): RealtimeClient => {
  const eventsSubject = new Subject<CoreServerEvent>();
  const toolCallStartsSubject = new Subject<ToolCallStart>();
  const remoteAudioStreamSubject = new Subject<MediaStream>();
  const callArgumentStreams = new Map<string, Subject<string>>();
  const callNameById = new Map<string, string>();

  let peerConnection: RealtimePeerConnectionLike | null = null;
  let dataChannel: RealtimeDataChannelLike | null = null;
  let microphoneTrack: RealtimeMediaStreamTrackLike | null = null;
  let microphoneStream: RealtimeMediaStreamLike | null = null;

  const send = (event: CoreClientEvent): void => {
    let validatedEvent: CoreClientEvent;

    try {
      validatedEvent = parseCoreClientEvent(event);
    } catch {
      eventsSubject.next(
        createLocalErrorEvent("Client payload failed validation.")
      );
      return;
    }

    if (dataChannel === null || dataChannel.readyState !== "open") {
      eventsSubject.next(
        createLocalErrorEvent("Cannot send before data channel is open.")
      );
      return;
    }

    try {
      dataChannel.send(JSON.stringify(validatedEvent));
    } catch {
      eventsSubject.next(
        createLocalErrorEvent("Client payload is not JSON serializable.")
      );
    }
  };

  const connect = async (): Promise<void> => {
    if (peerConnection !== null || dataChannel !== null) {
      return;
    }

    const nextPeerConnection = createPeerConnection(options, eventsSubject);
    peerConnection = nextPeerConnection;

    const nextDataChannel = nextPeerConnection.createDataChannel(
      options.dataChannelLabel ?? DEFAULT_DATA_CHANNEL_LABEL
    );
    dataChannel = nextDataChannel;

    const dataChannelOpenPromise = wireDataChannel({
      callArgumentStreams,
      callNameById,
      dataChannel: nextDataChannel,
      eventsSubject,
      toolCallStartsSubject
    });

    nextPeerConnection.ontrack = (event) => {
      const stream = resolveRemoteAudioStream(event);
      if (stream !== null) {
        remoteAudioStreamSubject.next(stream);
      }
    };

    nextPeerConnection.onconnectionstatechange = () => {
      const isDisconnected = isPeerDisconnected(nextPeerConnection);
      if (!isDisconnected) {
        return;
      }

      teardownConnection({
        callArgumentStreams,
        callNameById,
        dataChannel,
        eventsSubject,
        microphoneStream,
        microphoneTrack,
        peerConnection
      });
      dataChannel = null;
      microphoneStream = null;
      microphoneTrack = null;
      peerConnection = null;
    };

    ensureAudioTransceiver(nextPeerConnection);
    const initialMicrophone = await tryCreateMicrophoneTrack(
      options,
      eventsSubject
    );
    if (initialMicrophone !== null) {
      nextPeerConnection.addTrack(
        initialMicrophone.track,
        initialMicrophone.stream
      );
      microphoneTrack = initialMicrophone.track;
      microphoneStream = initialMicrophone.stream;
    }

    const offer = await nextPeerConnection.createOffer();
    await nextPeerConnection.setLocalDescription(offer);

    const answerSdp = await exchangeSessionSdp(
      options,
      offer.sdp,
      eventsSubject
    );

    if (answerSdp === null) {
      teardownConnection({
        callArgumentStreams,
        callNameById,
        dataChannel,
        eventsSubject,
        microphoneStream,
        microphoneTrack,
        peerConnection
      });
      dataChannel = null;
      microphoneStream = null;
      microphoneTrack = null;
      peerConnection = null;
      return;
    }

    await nextPeerConnection.setRemoteDescription({
      sdp: answerSdp,
      type: "answer"
    });

    await dataChannelOpenPromise;
  };

  const disconnect = (): void => {
    teardownConnection({
      callArgumentStreams,
      callNameById,
      dataChannel,
      eventsSubject,
      microphoneStream,
      microphoneTrack,
      peerConnection
    });
    dataChannel = null;
    microphoneStream = null;
    microphoneTrack = null;
    peerConnection = null;
  };

  const setMicrophoneEnabled = async (enabled: boolean): Promise<void> => {
    if (!enabled) {
      if (microphoneTrack !== null) {
        microphoneTrack.enabled = false;
      }
      return;
    }

    if (peerConnection === null) {
      eventsSubject.next(
        createLocalErrorEvent(
          "Cannot enable microphone before peer connection is established."
        )
      );
      return;
    }

    if (microphoneTrack !== null) {
      microphoneTrack.enabled = true;
      return;
    }

    const nextMicrophone = await tryCreateMicrophoneTrack(
      options,
      eventsSubject
    );
    if (nextMicrophone === null) {
      return;
    }

    peerConnection.addTrack(nextMicrophone.track, nextMicrophone.stream);
    microphoneTrack = nextMicrophone.track;
    microphoneStream = nextMicrophone.stream;
  };

  return {
    connect,
    disconnect,
    events$: eventsSubject.asObservable(),
    remoteAudioStream$: remoteAudioStreamSubject.asObservable(),
    send,
    setMicrophoneEnabled,
    toolCallStarts$: toolCallStartsSubject.asObservable()
  };
};

type TeardownInput = {
  callArgumentStreams: Map<string, Subject<string>>;
  callNameById: Map<string, string>;
  dataChannel: RealtimeDataChannelLike | null;
  eventsSubject: Subject<CoreServerEvent>;
  microphoneStream: RealtimeMediaStreamLike | null;
  microphoneTrack: RealtimeMediaStreamTrackLike | null;
  peerConnection: RealtimePeerConnectionLike | null;
};

type MicrophoneCaptureResult = {
  stream: RealtimeMediaStreamLike;
  track: RealtimeMediaStreamTrackLike;
};

/**
 * Closes active transport resources and emits connection-closed event.
 *
 * @param input Transport resources and sinks.
 */
const teardownConnection = (input: TeardownInput): void => {
  if (input.dataChannel !== null) {
    input.dataChannel.onclose = null;
    input.dataChannel.onerror = null;
    input.dataChannel.onmessage = null;
    input.dataChannel.onopen = null;
  }

  if (input.peerConnection !== null) {
    input.peerConnection.onconnectionstatechange = null;
    input.peerConnection.ontrack = null;
  }

  input.dataChannel?.close();
  input.peerConnection?.close();
  input.microphoneTrack?.stop();
  input.microphoneStream?.getTracks().forEach((track) => {
    track.stop();
  });
  completeCallStreams(input.callArgumentStreams);
  input.callNameById.clear();
  input.eventsSubject.next({
    type: "runtime.connection.closed"
  });
};

/**
 * Creates a peer connection from options or global runtime constructor.
 *
 * @param options Client options.
 * @param eventsSubject Event sink for local transport failures.
 * @returns Created peer connection.
 */
const createPeerConnection = (
  options: CreateRealtimeClientOptions,
  eventsSubject: Subject<CoreServerEvent>
): RealtimePeerConnectionLike => {
  if (options.peerConnectionFactory !== undefined) {
    return options.peerConnectionFactory();
  }

  if (typeof RTCPeerConnection === "undefined") {
    eventsSubject.next(
      createLocalErrorEvent("Global RTCPeerConnection is not available.")
    );
    throw new Error("Global RTCPeerConnection is not available.");
  }

  return createBrowserPeerConnectionAdapter(new RTCPeerConnection());
};

type WireDataChannelInput = {
  callArgumentStreams: Map<string, Subject<string>>;
  callNameById: Map<string, string>;
  dataChannel: RealtimeDataChannelLike;
  eventsSubject: Subject<CoreServerEvent>;
  toolCallStartsSubject: Subject<ToolCallStart>;
};

/**
 * Wires realtime data channel handlers and resolves when channel opens.
 *
 * @param input Data channel wiring inputs.
 * @returns Promise resolved once open callback fires.
 */
const wireDataChannel = (input: WireDataChannelInput): Promise<void> => {
  return new Promise((resolve) => {
    input.dataChannel.onopen = () => {
      input.eventsSubject.next({
        type: "runtime.connection.open"
      });
      resolve();
    };

    input.dataChannel.onerror = () => {
      input.eventsSubject.next(
        createLocalErrorEvent("Data channel transport error.")
      );
    };

    input.dataChannel.onclose = () => {
      completeCallStreams(input.callArgumentStreams);
      input.eventsSubject.next({
        type: "runtime.connection.closed"
      });
    };

    input.dataChannel.onmessage = (message) => {
      handleIncomingMessage(
        message.data,
        input.eventsSubject,
        input.toolCallStartsSubject,
        input.callArgumentStreams,
        input.callNameById
      );
    };
  });
};

/**
 * Exchanges local offer SDP for remote answer SDP via runtime session endpoint.
 *
 * @param options Client options.
 * @param offerSdp Offer SDP string.
 * @param eventsSubject Event sink for local failures.
 * @returns Answer SDP when exchange succeeds; otherwise `null`.
 */
const exchangeSessionSdp = async (
  options: CreateRealtimeClientOptions,
  offerSdp: string | undefined,
  eventsSubject: Subject<CoreServerEvent>
): Promise<string | null> => {
  if (offerSdp === undefined || offerSdp.length === 0) {
    eventsSubject.next(
      createLocalErrorEvent("Peer offer did not include SDP.")
    );
    return null;
  }

  const formData = new FormData();
  formData.set("sdp", offerSdp);
  formData.set("session", JSON.stringify(options.session));

  const fetchImpl = options.fetchImpl ?? fetch;

  try {
    const response = await fetchImpl(options.sessionEndpoint, {
      body: formData,
      method: "POST"
    });

    const responseBody = await response.text();

    if (!response.ok) {
      eventsSubject.next(
        createLocalErrorEvent(
          `Session setup failed with status ${response.status}: ${responseBody}`
        )
      );
      return null;
    }

    if (responseBody.length === 0) {
      eventsSubject.next(
        createLocalErrorEvent("Session setup returned empty SDP.")
      );
      return null;
    }

    return responseBody;
  } catch (error: unknown) {
    eventsSubject.next(createLocalErrorEvent(toErrorMessage(error)));
    return null;
  }
};

/**
 * Resolves a getUserMedia function from options or global navigator runtime.
 *
 * @param options Client options.
 * @returns getUserMedia implementation, or `null` when unavailable.
 */
const resolveGetUserMedia = (
  options: CreateRealtimeClientOptions
):
  | ((constraints: MediaStreamConstraints) => Promise<RealtimeMediaStreamLike>)
  | null => {
  if (options.getUserMedia !== undefined) {
    return options.getUserMedia;
  }

  if (
    typeof navigator === "undefined" ||
    navigator.mediaDevices === undefined ||
    navigator.mediaDevices.getUserMedia === undefined
  ) {
    return null;
  }

  return navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
};

/**
 * Attempts to capture and validate a local microphone track.
 *
 * @param options Client options.
 * @param eventsSubject Event sink for local failures.
 * @returns Validated track/stream pair, or `null` when microphone capture is unavailable.
 */
const tryCreateMicrophoneTrack = async (
  options: CreateRealtimeClientOptions,
  eventsSubject: Subject<CoreServerEvent>
): Promise<MicrophoneCaptureResult | null> => {
  const getUserMedia = resolveGetUserMedia(options);
  if (getUserMedia === null) {
    return null;
  }

  try {
    const stream = await getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true
      }
    });
    const track = stream.getAudioTracks().at(0);

    if (track === undefined) {
      eventsSubject.next(
        createLocalErrorEvent(
          "Microphone stream did not include an audio track."
        )
      );
      stream.getTracks().forEach((streamTrack) => {
        streamTrack.stop();
      });
      return null;
    }

    track.enabled = true;
    return {
      stream,
      track
    };
  } catch (error: unknown) {
    eventsSubject.next(createLocalErrorEvent(toErrorMessage(error)));
    return null;
  }
};

/**
 * Resolves a remote audio stream from a WebRTC track event.
 *
 * @param event Peer connection track event.
 * @returns Remote audio stream, or `null` when no compatible stream can be built.
 */
const resolveRemoteAudioStream = (
  event: RealtimeTrackEventLike
): MediaStream | null => {
  const existingStream = event.streams.at(0);
  if (existingStream !== undefined) {
    return existingStream;
  }

  const track = event.track;
  if (track === undefined || typeof MediaStream === "undefined") {
    return null;
  }

  const stream = new MediaStream();
  // Escape hatch: runtime track is structurally compatible with MediaStreamTrack
  // and originates from browser RTCPeerConnection track events.
  stream.addTrack(track as MediaStreamTrack);
  return stream;
};

/**
 * Adds an audio transceiver before offer creation so generated SDP always includes audio media.
 *
 * @param peerConnection Active peer connection.
 */
const ensureAudioTransceiver = (
  peerConnection: RealtimePeerConnectionLike
): void => {
  peerConnection.addTransceiver?.("audio", {
    direction: "recvonly"
  });
};

/**
 * Creates a `RealtimePeerConnectionLike` adapter from native browser RTCPeerConnection.
 *
 * @param peerConnection Native RTCPeerConnection instance.
 * @returns Peer connection adapter for core transport logic.
 */
const createBrowserPeerConnectionAdapter = (
  peerConnection: RTCPeerConnection
): RealtimePeerConnectionLike => {
  const adapter: RealtimePeerConnectionLike = {
    addTransceiver: (kind, options) => {
      return peerConnection.addTransceiver(kind, options);
    },
    addTrack: (track, ...streams) => {
      // Escape hatch: runtime supplies native MediaStreamTrack/MediaStream values, but
      // the core adapter surface intentionally models only the required subset.
      peerConnection.addTrack(
        track as MediaStreamTrack,
        ...(streams as MediaStream[])
      );
    },
    close: () => {
      peerConnection.close();
    },
    get connectionState() {
      return peerConnection.connectionState;
    },
    createDataChannel: (label: string) => {
      return createBrowserDataChannelAdapter(
        peerConnection.createDataChannel(label)
      );
    },
    createOffer: () => {
      return peerConnection.createOffer();
    },
    onconnectionstatechange: null,
    ontrack: null,
    setLocalDescription: (description) => {
      return peerConnection.setLocalDescription(description);
    },
    setRemoteDescription: (description) => {
      return peerConnection.setRemoteDescription(description);
    }
  };

  peerConnection.addEventListener("connectionstatechange", () => {
    adapter.onconnectionstatechange?.();
  });

  peerConnection.addEventListener("track", (event) => {
    adapter.ontrack?.({
      streams: event.streams,
      track: event.track
    });
  });

  return adapter;
};

/**
 * Creates a `RealtimeDataChannelLike` adapter from native browser RTCDataChannel.
 *
 * @param dataChannel Native RTCDataChannel.
 * @returns Data channel adapter for core transport logic.
 */
const createBrowserDataChannelAdapter = (
  dataChannel: RTCDataChannel
): RealtimeDataChannelLike => {
  const adapter: RealtimeDataChannelLike = {
    close: () => {
      dataChannel.close();
    },
    onclose: null,
    onerror: null,
    onmessage: null,
    onopen: null,
    get readyState() {
      return dataChannel.readyState;
    },
    send: (payload: string) => {
      dataChannel.send(payload);
    }
  };

  dataChannel.addEventListener("open", () => {
    adapter.onopen?.();
  });

  dataChannel.addEventListener("close", () => {
    adapter.onclose?.();
  });

  dataChannel.addEventListener("error", (event) => {
    adapter.onerror?.(event);
  });

  dataChannel.addEventListener("message", (event) => {
    if (typeof event.data === "string") {
      adapter.onmessage?.({
        data: event.data
      });
    }
  });

  return adapter;
};

/**
 * Handles a single inbound data channel message from runtime.
 *
 * @param serialized Serialized message string.
 * @param eventsSubject Subject for all server events.
 * @param toolCallStartsSubject Subject for new tool call streams.
 * @param callArgumentStreams Per-call stream map.
 */
const handleIncomingMessage = (
  serialized: string,
  eventsSubject: Subject<CoreServerEvent>,
  toolCallStartsSubject: Subject<ToolCallStart>,
  callArgumentStreams: Map<string, Subject<string>>,
  callNameById: Map<string, string>
): void => {
  const parsedJson = parseJsonRecord(serialized);

  if (parsedJson === null) {
    eventsSubject.next(createLocalErrorEvent("Received invalid JSON payload."));
    return;
  }

  let event: CoreServerEvent;

  try {
    event = parseCoreServerEvent(parsedJson);
  } catch {
    eventsSubject.next(
      createLocalErrorEvent("Received invalid event envelope.")
    );
    return;
  }

  const addedMetadata = extractFunctionCallMetadata(parsedJson);
  if (addedMetadata !== null) {
    callNameById.set(addedMetadata.callId, addedMetadata.name);
  }

  const normalizedEvent = enrichDoneEventWithCallMetadata(event, callNameById);

  if (isFunctionCallArgumentsDeltaEvent(normalizedEvent)) {
    const existingStream = callArgumentStreams.get(normalizedEvent.call_id);

    if (existingStream === undefined) {
      const nextStream = new Subject<string>();
      callArgumentStreams.set(normalizedEvent.call_id, nextStream);
      toolCallStartsSubject.next({
        argumentChunks$: nextStream.asObservable(),
        callId: normalizedEvent.call_id,
        itemId: normalizedEvent.item_id ?? normalizedEvent.call_id,
        responseId: normalizedEvent.response_id ?? "unknown_response"
      });
      nextStream.next(normalizedEvent.delta);
    } else {
      existingStream.next(normalizedEvent.delta);
    }
  }

  if (isFunctionCallArgumentsDoneEvent(normalizedEvent)) {
    const stream = callArgumentStreams.get(normalizedEvent.call_id);

    if (stream !== undefined) {
      stream.complete();
      callArgumentStreams.delete(normalizedEvent.call_id);
    }
    callNameById.delete(normalizedEvent.call_id);
  }

  eventsSubject.next(normalizedEvent);
};

/**
 * Extracts function call metadata from output-item-added events.
 *
 * @param payload Parsed event payload.
 * @returns Call metadata, or `null` when payload does not contain function-call metadata.
 */
const extractFunctionCallMetadata = (
  payload: Readonly<Record<string, unknown>>
): { callId: string; name: string } | null => {
  if (payload.type !== "response.output_item.added") {
    return null;
  }

  const item = payload.item;
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
 * Enriches function-call done events with previously observed call metadata.
 *
 * @param event Parsed server event.
 * @param callNameById Known call-id to tool-name mapping.
 * @returns Original event or enriched done event.
 */
const enrichDoneEventWithCallMetadata = (
  event: CoreServerEvent,
  callNameById: ReadonlyMap<string, string>
): CoreServerEvent => {
  if (!isFunctionCallArgumentsDoneEvent(event) || event.name !== undefined) {
    return event;
  }

  const name = callNameById.get(event.call_id);
  if (name === undefined) {
    return event;
  }

  return {
    ...event,
    name
  };
};

/**
 * Parses serialized JSON into an object record.
 *
 * @param serialized Raw json string.
 * @returns Parsed object record or `null`.
 */
const parseJsonRecord = (
  serialized: string
): Record<string, unknown> | null => {
  try {
    const parsed: unknown = JSON.parse(serialized);
    const result = jsonRecordSchema.safeParse(parsed);
    if (!result.success) {
      return null;
    }
    return result.data;
  } catch {
    return null;
  }
};

/**
 * Completes and clears all outstanding call argument streams.
 *
 * @param callArgumentStreams Mutable map of call id to chunk stream.
 */
const completeCallStreams = (
  callArgumentStreams: Map<string, Subject<string>>
): void => {
  callArgumentStreams.forEach((stream) => {
    stream.complete();
  });

  callArgumentStreams.clear();
};

/**
 * Determines whether a peer connection state should be treated as disconnected.
 *
 * @param peerConnection Peer connection to inspect.
 * @returns `true` when state indicates transport closure.
 */
const isPeerDisconnected = (
  peerConnection: RealtimePeerConnectionLike
): boolean => {
  return (
    peerConnection.connectionState === "closed" ||
    peerConnection.connectionState === "disconnected"
  );
};

/**
 * Creates a local error event envelope for transport/protocol failures.
 *
 * @param message Human-readable error message.
 * @returns Error event payload.
 */
const createLocalErrorEvent = (message: string): CoreServerEvent => {
  return {
    error: {
      message,
      type: "core_client_error"
    },
    type: "error"
  };
};

/**
 * Converts unknown errors to human-readable strings.
 *
 * @param error Unknown error value.
 * @returns Error message.
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
 * Re-exports observable type to make API docs explicit.
 */
export type { Observable };
