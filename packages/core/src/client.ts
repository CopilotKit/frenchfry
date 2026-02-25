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
  FunctionCallArgumentsDoneEvent,
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
  const callArgumentTextById = new Map<string, string>();
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
      callArgumentTextById,
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
        callArgumentTextById,
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
        callArgumentTextById,
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
      callArgumentTextById,
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
  callArgumentTextById: Map<string, string>;
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
  input.callArgumentTextById.clear();
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
  callArgumentTextById: Map<string, string>;
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
      input.callArgumentTextById.clear();
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
        input.callArgumentTextById,
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
  callArgumentTextById: Map<string, string>,
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
  const normalizedEvents = createNormalizedEventBatch(
    parsedJson,
    normalizedEvent,
    callArgumentTextById,
    callNameById
  );
  debugToolLoop("incoming", {
    normalizedTypes: normalizedEvents.map((nextEvent) => nextEvent.type),
    rawType: parsedJson.type
  });

  normalizedEvents.forEach((nextEvent) => {
    processToolCallStreamEvent({
      callArgumentStreams,
      callArgumentTextById,
      callNameById,
      event: nextEvent,
      toolCallStartsSubject
    });
    eventsSubject.next(nextEvent);
  });
};

type ProcessToolCallStreamEventInput = {
  callArgumentStreams: Map<string, Subject<string>>;
  callArgumentTextById: Map<string, string>;
  callNameById: Map<string, string>;
  event: CoreServerEvent;
  toolCallStartsSubject: Subject<ToolCallStart>;
};

/**
 * Routes normalized function-call events into per-call argument streams.
 *
 * @param input Normalized event plus mutable stream maps.
 */
const processToolCallStreamEvent = (
  input: ProcessToolCallStreamEventInput
): void => {
  if (isFunctionCallArgumentsDeltaEvent(input.event)) {
    debugToolLoop("delta", {
      callId: input.event.call_id,
      deltaLength: input.event.delta.length
    });
    const existingStream = input.callArgumentStreams.get(input.event.call_id);
    const previousArgumentText =
      input.callArgumentTextById.get(input.event.call_id) ?? "";
    input.callArgumentTextById.set(
      input.event.call_id,
      `${previousArgumentText}${input.event.delta}`
    );

    if (existingStream === undefined) {
      const nextStream = new Subject<string>();
      input.callArgumentStreams.set(input.event.call_id, nextStream);
      input.toolCallStartsSubject.next({
        argumentChunks$: nextStream.asObservable(),
        callId: input.event.call_id,
        itemId: input.event.item_id ?? input.event.call_id,
        responseId: input.event.response_id ?? "unknown_response"
      });
      nextStream.next(input.event.delta);
    } else {
      existingStream.next(input.event.delta);
    }

    return;
  }

  if (!isFunctionCallArgumentsDoneEvent(input.event)) {
    return;
  }
  debugToolLoop("done", {
    argumentsLength: input.event.arguments.length,
    callId: input.event.call_id,
    name: input.event.name
  });

  const existingStream = input.callArgumentStreams.get(input.event.call_id);
  const stream = existingStream ?? new Subject<string>();

  if (existingStream === undefined) {
    input.callArgumentStreams.set(input.event.call_id, stream);
    input.toolCallStartsSubject.next({
      argumentChunks$: stream.asObservable(),
      callId: input.event.call_id,
      itemId: input.event.item_id ?? input.event.call_id,
      responseId: input.event.response_id ?? "unknown_response"
    });

    if (input.event.arguments.length > 0) {
      stream.next(input.event.arguments);
    }
  }

  stream.complete();
  input.callArgumentStreams.delete(input.event.call_id);
  input.callArgumentTextById.delete(input.event.call_id);
  input.callNameById.delete(input.event.call_id);
};

/**
 * Creates a normalized event batch, including synthesized function-call done events.
 *
 * @param rawPayload Raw parsed server payload.
 * @param parsedEvent Parsed core server event.
 * @param callNameById Known call-id to tool-name mapping.
 * @returns Ordered event batch to emit.
 */
const createNormalizedEventBatch = (
  rawPayload: Readonly<Record<string, unknown>>,
  parsedEvent: CoreServerEvent,
  callArgumentTextById: ReadonlyMap<string, string>,
  callNameById: ReadonlyMap<string, string>
): readonly CoreServerEvent[] => {
  const outputItemDoneEvents = extractFunctionCallDoneEventsFromOutputItemDone(
    rawPayload,
    callArgumentTextById,
    callNameById
  );
  const conversationItemAddedEvents =
    extractFunctionCallDoneEventsFromConversationItemAdded(rawPayload).map(
      (event) => {
        return enrichDoneEventMetadata(event, callNameById);
      }
    );
  const conversationItemDoneEvents =
    extractFunctionCallDoneEventsFromConversationItemDone(rawPayload).map(
      (event) => {
        return enrichDoneEventMetadata(event, callNameById);
      }
    );
  const extractedDoneEvents =
    extractFunctionCallDoneEventsFromResponseDone(rawPayload);
  const responseDoneEvents = extractedDoneEvents.map((event) => {
    return enrichDoneEventMetadata(event, callNameById);
  });
  const synthesizedDoneEvents = dedupeDoneEvents([
    ...outputItemDoneEvents,
    ...conversationItemAddedEvents,
    ...conversationItemDoneEvents,
    ...responseDoneEvents
  ]);
  if (outputItemDoneEvents.length > 0) {
    debugToolLoop("response.output_item.done synthesized", {
      callIds: outputItemDoneEvents.map((event) => event.call_id),
      count: outputItemDoneEvents.length
    });
  }
  if (extractedDoneEvents.length > 0) {
    debugToolLoop("response.done synthesized", {
      callIds: extractedDoneEvents.map((event) => event.call_id),
      count: extractedDoneEvents.length
    });
  }
  if (conversationItemAddedEvents.length > 0) {
    debugToolLoop("conversation.item.added synthesized", {
      callIds: conversationItemAddedEvents.map((event) => event.call_id),
      count: conversationItemAddedEvents.length
    });
  }
  if (conversationItemDoneEvents.length > 0) {
    debugToolLoop("conversation.item.done synthesized", {
      callIds: conversationItemDoneEvents.map((event) => event.call_id),
      count: conversationItemDoneEvents.length
    });
  }

  if (synthesizedDoneEvents.length === 0) {
    return [parsedEvent];
  }

  return [parsedEvent, ...synthesizedDoneEvents];
};

/**
 * Extracts function-call completion events from a `response.output_item.done` payload.
 *
 * @param payload Parsed server payload.
 * @param callArgumentTextById Known call-id to accumulated argument text.
 * @param callNameById Known call-id to tool-name mapping.
 * @returns Normalized done events discovered in output-item payload.
 */
const extractFunctionCallDoneEventsFromOutputItemDone = (
  payload: Readonly<Record<string, unknown>>,
  callArgumentTextById: ReadonlyMap<string, string>,
  callNameById: ReadonlyMap<string, string>
): readonly FunctionCallArgumentsDoneEvent[] => {
  if (payload.type !== "response.output_item.done") {
    return [];
  }

  const item = toUnknownRecord(payload.item);
  if (item === null || item.type !== "function_call") {
    return [];
  }

  if (typeof item.call_id !== "string") {
    return [];
  }

  const serializedArguments = serializeFunctionArguments(item.arguments);
  const fallbackArguments = callArgumentTextById.get(item.call_id);
  const resolvedArguments =
    serializedArguments === null ? fallbackArguments : serializedArguments;
  const fallbackName = callNameById.get(item.call_id);

  if (resolvedArguments === undefined) {
    return [];
  }

  const doneEvent: FunctionCallArgumentsDoneEvent = {
    arguments: resolvedArguments,
    call_id: item.call_id,
    ...(typeof item.id === "string" ? { item_id: item.id } : {}),
    ...(typeof item.name === "string"
      ? { name: item.name }
      : fallbackName === undefined
        ? {}
        : { name: fallbackName }),
    ...(typeof payload.output_index === "number"
      ? { output_index: payload.output_index }
      : {}),
    ...(typeof payload.response_id === "string"
      ? { response_id: payload.response_id }
      : {}),
    type: "response.function_call_arguments.done"
  };

  return [doneEvent];
};

/**
 * Extracts function-call completion events from a `conversation.item.done` payload.
 *
 * @param payload Parsed server payload.
 * @returns Normalized done events discovered in conversation item payload.
 */
const extractFunctionCallDoneEventsFromConversationItemDone = (
  payload: Readonly<Record<string, unknown>>
): readonly FunctionCallArgumentsDoneEvent[] => {
  if (payload.type !== "conversation.item.done") {
    return [];
  }

  const item = toUnknownRecord(payload.item);
  if (item === null) {
    return [];
  }

  if (item.type !== "function_call") {
    return [];
  }

  if (typeof item.call_id !== "string") {
    return [];
  }

  const serializedArguments = serializeFunctionArguments(item.arguments);
  if (serializedArguments === null) {
    return [];
  }

  const doneEvent: FunctionCallArgumentsDoneEvent = {
    arguments: serializedArguments,
    call_id: item.call_id,
    ...(typeof item.id === "string" ? { item_id: item.id } : {}),
    ...(typeof item.name === "string" ? { name: item.name } : {}),
    ...(typeof payload.response_id === "string"
      ? { response_id: payload.response_id }
      : {}),
    type: "response.function_call_arguments.done"
  };

  return [doneEvent];
};

/**
 * Extracts function-call completion events from a `conversation.item.added` payload.
 *
 * @param payload Parsed server payload.
 * @returns Normalized done events when a completed function-call item is included.
 */
const extractFunctionCallDoneEventsFromConversationItemAdded = (
  payload: Readonly<Record<string, unknown>>
): readonly FunctionCallArgumentsDoneEvent[] => {
  if (payload.type !== "conversation.item.added") {
    return [];
  }

  const item = toUnknownRecord(payload.item);
  if (item === null) {
    return [];
  }

  if (item.type !== "function_call" || item.status !== "completed") {
    return [];
  }

  if (typeof item.call_id !== "string") {
    return [];
  }

  const serializedArguments = serializeFunctionArguments(item.arguments);
  if (serializedArguments === null) {
    return [];
  }

  const doneEvent: FunctionCallArgumentsDoneEvent = {
    arguments: serializedArguments,
    call_id: item.call_id,
    ...(typeof item.id === "string" ? { item_id: item.id } : {}),
    ...(typeof item.name === "string" ? { name: item.name } : {}),
    ...(typeof payload.response_id === "string"
      ? { response_id: payload.response_id }
      : {}),
    type: "response.function_call_arguments.done"
  };

  return [doneEvent];
};

/**
 * Deduplicates normalized done events by stable event identity fields.
 *
 * @param events Candidate done events.
 * @returns Deduplicated done events.
 */
const dedupeDoneEvents = (
  events: readonly FunctionCallArgumentsDoneEvent[]
): readonly FunctionCallArgumentsDoneEvent[] => {
  const seen = new Set<string>();
  const deduped: FunctionCallArgumentsDoneEvent[] = [];

  events.forEach((event) => {
    const key = `${event.call_id}::${event.arguments}::${event.name ?? ""}::${event.item_id ?? ""}::${event.response_id ?? ""}`;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    deduped.push(event);
  });

  return deduped;
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
 * Enriches a normalized done event with known call metadata while preserving event type.
 *
 * @param event Done event.
 * @param callNameById Known call-id to tool-name mapping.
 * @returns Done event with optional name filled from known metadata.
 */
const enrichDoneEventMetadata = (
  event: FunctionCallArgumentsDoneEvent,
  callNameById: ReadonlyMap<string, string>
): FunctionCallArgumentsDoneEvent => {
  const enriched = enrichDoneEventWithCallMetadata(event, callNameById);
  if (!isFunctionCallArgumentsDoneEvent(enriched)) {
    return event;
  }

  return enriched;
};

/**
 * Extracts function-call completion events from a `response.done` payload.
 *
 * @param payload Parsed server payload.
 * @returns Normalized done events discovered in response output items.
 */
const extractFunctionCallDoneEventsFromResponseDone = (
  payload: Readonly<Record<string, unknown>>
): readonly FunctionCallArgumentsDoneEvent[] => {
  if (payload.type !== "response.done") {
    return [];
  }

  const response = toUnknownRecord(payload.response);
  if (response === null) {
    return [];
  }

  const output = response.output;
  if (!Array.isArray(output)) {
    return [];
  }

  const responseId = typeof response.id === "string" ? response.id : undefined;
  const events: FunctionCallArgumentsDoneEvent[] = [];

  output.forEach((item, outputIndex) => {
    const itemRecord = toUnknownRecord(item);
    if (itemRecord === null) {
      return;
    }

    if (itemRecord.type !== "function_call") {
      return;
    }

    if (typeof itemRecord.call_id !== "string") {
      return;
    }

    const serializedArguments = serializeFunctionArguments(itemRecord.arguments);
    if (serializedArguments === null) {
      return;
    }

    const doneEvent: FunctionCallArgumentsDoneEvent = {
      arguments: serializedArguments,
      call_id: itemRecord.call_id,
      output_index: outputIndex,
      ...(responseId === undefined ? {} : { response_id: responseId }),
      ...(typeof itemRecord.id === "string" ? { item_id: itemRecord.id } : {}),
      ...(typeof itemRecord.name === "string" ? { name: itemRecord.name } : {}),
      type: "response.function_call_arguments.done"
    };

    events.push(doneEvent);
  });

  return events;
};

/**
 * Narrows unknown runtime values to object records.
 *
 * @param value Runtime value.
 * @returns Record value, or `null` when value is not an object.
 */
const toUnknownRecord = (
  value: unknown
): Readonly<Record<string, unknown>> | null => {
  const parsed = jsonRecordSchema.safeParse(value);
  if (!parsed.success) {
    return null;
  }

  return parsed.data;
};

/**
 * Emits debug logs for tool-loop behavior when enabled by global flag.
 *
 * @param message Log message.
 * @param payload Optional structured payload.
 */
const debugToolLoop = (
  message: string,
  payload?: Readonly<Record<string, unknown>>
): void => {
  if (payload === undefined) {
    console.log("[frenchfry:core:tool-loop]", message);
    return;
  }

  console.log(
    "[frenchfry:core:tool-loop]",
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
 * Normalizes function-call argument payloads into strings for downstream parsing.
 *
 * @param value Runtime argument payload from server events.
 * @returns Argument string, or `null` when value is missing or not serializable.
 */
const serializeFunctionArguments = (value: unknown): string | null => {
  if (value === undefined) {
    return null;
  }

  if (typeof value === "string") {
    return value;
  }

  try {
    return JSON.stringify(value);
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
