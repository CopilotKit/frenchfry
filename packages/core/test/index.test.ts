import { expect, test, vi } from "vitest";
import { z } from "zod";

import {
  CORE_PACKAGE_NAME,
  createRealtimeClient,
  isErrorEvent,
  isFunctionCallArgumentsDeltaEvent,
  isFunctionCallArgumentsDoneEvent,
  parseCoreClientEvent,
  parseCoreServerEvent,
  toUnknownServerEvent,
  type RealtimeDataChannelLike,
  type RealtimeMediaStreamLike,
  type RealtimeMediaStreamTrackLike,
  type RealtimePeerConnectionLike,
  type RealtimeTrackEventLike,
  type ToolCallStart
} from "../src/index";

class FakeDataChannel implements RealtimeDataChannelLike {
  public onclose: (() => void) | null = null;

  public onerror: ((event: unknown) => void) | null = null;

  public onmessage: ((event: { data: string }) => void) | null = null;

  public onopen: (() => void) | null = null;

  public readyState: "closed" | "closing" | "connecting" | "open" =
    "connecting";

  public readonly sentPayloads: string[] = [];

  public close(): void {
    this.readyState = "closed";
    this.onclose?.();
  }

  public emitError(error: unknown): void {
    this.onerror?.(error);
  }

  public emitMessage(payload: Record<string, unknown>): void {
    this.onmessage?.({ data: JSON.stringify(payload) });
  }

  public open(): void {
    this.readyState = "open";
    this.onopen?.();
  }

  public send(payload: string): void {
    this.sentPayloads.push(payload);
  }
}

class FakePeerConnection implements RealtimePeerConnectionLike {
  public connectionState:
    | "closed"
    | "connected"
    | "connecting"
    | "disconnected"
    | "failed"
    | "new" = "new";

  public onconnectionstatechange: (() => void) | null = null;

  public ontrack: ((event: RealtimeTrackEventLike) => void) | null = null;

  public readonly createdChannels: FakeDataChannel[] = [];

  public readonly remoteDescriptions: RTCSessionDescriptionInit[] = [];

  public readonly localDescriptions: RTCSessionDescriptionInit[] = [];

  public readonly addedTracks: Array<{
    stream: RealtimeMediaStreamLike;
    track: RealtimeMediaStreamTrackLike;
  }> = [];
  public readonly addedTransceivers: Array<{
    direction?: "inactive" | "recvonly" | "sendonly" | "sendrecv";
    kind: "audio" | "video";
  }> = [];
  public readonly operationLog: string[] = [];

  public addTransceiver(
    kind: "audio" | "video",
    options?: {
      direction?: "inactive" | "recvonly" | "sendonly" | "sendrecv";
    }
  ): unknown {
    const entry =
      options?.direction === undefined
        ? { kind }
        : { direction: options.direction, kind };
    this.addedTransceivers.push(entry);
    this.operationLog.push("addTransceiver");
    return {};
  }

  public addTrack(
    track: RealtimeMediaStreamTrackLike,
    ...streams: RealtimeMediaStreamLike[]
  ): unknown {
    this.operationLog.push("addTrack");
    const stream = streams.at(0);
    if (stream !== undefined) {
      this.addedTracks.push({ stream, track });
    }

    return {};
  }

  public close(): void {
    this.connectionState = "closed";
    this.onconnectionstatechange?.();
  }

  public emitTrack(event: RealtimeTrackEventLike): void {
    this.ontrack?.(event);
  }

  public createDataChannel(label: string): FakeDataChannel {
    void label;
    const channel = new FakeDataChannel();
    this.createdChannels.push(channel);
    return channel;
  }

  public createOffer(): Promise<RTCSessionDescriptionInit> {
    this.operationLog.push("createOffer");
    return Promise.resolve({
      sdp: "offer-sdp",
      type: "offer"
    });
  }

  public setLocalDescription(
    description: RTCSessionDescriptionInit
  ): Promise<void> {
    this.localDescriptions.push(description);
    return Promise.resolve();
  }

  public setRemoteDescription(
    description: RTCSessionDescriptionInit
  ): Promise<void> {
    this.remoteDescriptions.push(description);
    this.connectionState = "connected";
    return Promise.resolve();
  }
}

/**
 * Parses a serialized JSON payload and validates object shape.
 *
 * @param serialized Serialized payload.
 * @returns Parsed object record.
 */
const parsePayloadRecord = (serialized: string): Record<string, unknown> => {
  const parsed: unknown = JSON.parse(serialized);
  const parsedResult = z.record(z.string(), z.unknown()).safeParse(parsed);
  if (!parsedResult.success) {
    throw new Error("Expected object payload.");
  }
  return parsedResult.data;
};

test("core package exposes a stable name marker", () => {
  // Arrange
  const expectedName = "@frenchfryai/core";

  // Act
  const actualName = CORE_PACKAGE_NAME;

  // Assert
  expect(actualName).toBe(expectedName);
});

test("connect establishes session and emits runtime.connection.open", async () => {
  // Arrange
  const peer = new FakePeerConnection();
  const fetchCalls: Array<{ body: FormData | null; url: string }> = [];
  const client = createRealtimeClient({
    fetchImpl: (input, init) => {
      const requestUrl =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      fetchCalls.push({
        body: init?.body instanceof FormData ? init.body : null,
        url: requestUrl
      });
      return Promise.resolve(new Response("answer-sdp", { status: 200 }));
    },
    peerConnectionFactory: () => peer,
    session: {
      model: "gpt-realtime",
      type: "realtime"
    },
    sessionEndpoint: "http://localhost/realtime/session"
  });

  const eventTypes: string[] = [];
  client.events$.subscribe((event) => {
    eventTypes.push(event.type);
  });

  // Act
  const connectPromise = client.connect();
  const channel = peer.createdChannels.at(0);
  if (channel === undefined) {
    throw new Error("Expected data channel to be created.");
  }
  channel.open();
  await connectPromise;

  // Assert
  expect(fetchCalls).toHaveLength(1);
  expect(fetchCalls[0]?.url).toBe("http://localhost/realtime/session");
  const formData = fetchCalls[0]?.body;
  if (formData === null || formData === undefined) {
    throw new Error("Expected form data body.");
  }
  expect(formData.get("sdp")).toBe("offer-sdp");
  expect(formData.get("session")).toBe(
    JSON.stringify({
      model: "gpt-realtime",
      type: "realtime"
    })
  );
  expect(eventTypes).toContain("runtime.connection.open");
});

test("connect configures an audio transceiver before creating the offer", async () => {
  // Arrange
  const peer = new FakePeerConnection();
  const client = createRealtimeClient({
    fetchImpl: () =>
      Promise.resolve(new Response("answer-sdp", { status: 200 })),
    peerConnectionFactory: () => peer,
    session: {
      model: "gpt-realtime",
      type: "realtime"
    },
    sessionEndpoint: "http://localhost/realtime/session"
  });

  // Act
  const connectPromise = client.connect();
  const channel = peer.createdChannels.at(0);
  if (channel === undefined) {
    throw new Error("Expected data channel to be created.");
  }
  channel.open();
  await connectPromise;

  // Assert
  expect(peer.addedTransceivers).toEqual([
    {
      direction: "recvonly",
      kind: "audio"
    }
  ]);
  expect(peer.operationLog).toEqual(["addTransceiver", "createOffer"]);
});

test("connect adds microphone track before creating the offer when available", async () => {
  // Arrange
  const peer = new FakePeerConnection();
  const track: RealtimeMediaStreamTrackLike = {
    enabled: false,
    stop: () => undefined
  };
  const stream: RealtimeMediaStreamLike = {
    getAudioTracks: () => {
      return [track];
    },
    getTracks: () => {
      return [track];
    }
  };
  const client = createRealtimeClient({
    fetchImpl: () =>
      Promise.resolve(new Response("answer-sdp", { status: 200 })),
    getUserMedia: () => Promise.resolve(stream),
    peerConnectionFactory: () => peer,
    session: {
      model: "gpt-realtime",
      type: "realtime"
    },
    sessionEndpoint: "http://localhost/realtime/session"
  });

  // Act
  const connectPromise = client.connect();
  const channel = peer.createdChannels.at(0);
  if (channel === undefined) {
    throw new Error("Expected data channel to be created.");
  }
  channel.open();
  await connectPromise;

  // Assert
  expect(track.enabled).toBe(true);
  expect(peer.addedTracks).toHaveLength(1);
  expect(peer.operationLog).toEqual([
    "addTransceiver",
    "addTrack",
    "createOffer"
  ]);
});

test("toolCallStarts$ emits once per call id and streams chunks in order", async () => {
  // Arrange
  const peer = new FakePeerConnection();
  const client = createRealtimeClient({
    fetchImpl: () =>
      Promise.resolve(new Response("answer-sdp", { status: 200 })),
    peerConnectionFactory: () => peer,
    session: {
      model: "gpt-realtime",
      type: "realtime"
    },
    sessionEndpoint: "http://localhost/realtime/session"
  });

  const starts: ToolCallStart[] = [];
  const chunks: string[] = [];

  client.toolCallStarts$.subscribe((start) => {
    starts.push(start);
    start.argumentChunks$.subscribe((chunk) => {
      chunks.push(chunk);
    });
  });

  const connectPromise = client.connect();
  const channel = peer.createdChannels.at(0);
  if (channel === undefined) {
    throw new Error("Expected data channel to be created.");
  }
  channel.open();
  await connectPromise;

  // Act
  channel.emitMessage({
    call_id: "call_1",
    delta: '{"city":"San',
    item_id: "fc_1",
    output_index: 0,
    response_id: "resp_1",
    type: "response.function_call_arguments.delta"
  });
  channel.emitMessage({
    call_id: "call_1",
    delta: ' Francisco"}',
    item_id: "fc_1",
    output_index: 0,
    response_id: "resp_1",
    type: "response.function_call_arguments.delta"
  });

  // Assert
  expect(starts).toHaveLength(1);
  expect(starts[0]?.callId).toBe("call_1");
  expect(chunks).toEqual(['{"city":"San', ' Francisco"}']);
});

test("remoteAudioStream$ emits stream built from track when ontrack has no stream list", async () => {
  // Arrange
  class FakeMediaStream {
    public readonly tracks: RealtimeMediaStreamTrackLike[] = [];

    public addTrack(track: RealtimeMediaStreamTrackLike): void {
      this.tracks.push(track);
    }
  }

  const originalMediaStream = globalThis.MediaStream;
  vi.stubGlobal("MediaStream", FakeMediaStream);
  try {
    const peer = new FakePeerConnection();
    const client = createRealtimeClient({
      fetchImpl: () =>
        Promise.resolve(new Response("answer-sdp", { status: 200 })),
      peerConnectionFactory: () => peer,
      session: {
        model: "gpt-realtime",
        type: "realtime"
      },
      sessionEndpoint: "http://localhost/realtime/session"
    });

    const emittedStreams: unknown[] = [];
    client.remoteAudioStream$.subscribe((stream) => {
      emittedStreams.push(stream);
    });

    const connectPromise = client.connect();
    const channel = peer.createdChannels.at(0);
    if (channel === undefined) {
      throw new Error("Expected data channel to be created.");
    }
    channel.open();
    await connectPromise;

    const track: RealtimeMediaStreamTrackLike = {
      enabled: true,
      stop: () => undefined
    };

    // Act
    peer.emitTrack({
      streams: [],
      track
    });

    // Assert
    expect(emittedStreams).toHaveLength(1);
    const emitted = emittedStreams[0];
    expect(emitted).toBeInstanceOf(FakeMediaStream);
    if (!(emitted instanceof FakeMediaStream)) {
      throw new Error("Expected emitted fake media stream instance.");
    }
    expect(emitted.tracks).toEqual([track]);
  } finally {
    if (originalMediaStream === undefined) {
      vi.unstubAllGlobals();
    } else {
      vi.stubGlobal("MediaStream", originalMediaStream);
    }
  }
});

test("argument stream completes when done event arrives", async () => {
  // Arrange
  const peer = new FakePeerConnection();
  const client = createRealtimeClient({
    fetchImpl: () =>
      Promise.resolve(new Response("answer-sdp", { status: 200 })),
    peerConnectionFactory: () => peer,
    session: {
      model: "gpt-realtime",
      type: "realtime"
    },
    sessionEndpoint: "http://localhost/realtime/session"
  });

  let completed = false;

  client.toolCallStarts$.subscribe((start) => {
    start.argumentChunks$.subscribe({
      complete: () => {
        completed = true;
      }
    });
  });

  const connectPromise = client.connect();
  const channel = peer.createdChannels.at(0);
  if (channel === undefined) {
    throw new Error("Expected data channel to be created.");
  }
  channel.open();
  await connectPromise;

  channel.emitMessage({
    call_id: "call_2",
    delta: "{}",
    item_id: "fc_2",
    output_index: 0,
    response_id: "resp_2",
    type: "response.function_call_arguments.delta"
  });

  // Act
  channel.emitMessage({
    arguments: "{}",
    call_id: "call_2",
    item_id: "fc_2",
    output_index: 0,
    response_id: "resp_2",
    type: "response.function_call_arguments.done"
  });

  // Assert
  expect(completed).toBe(true);
});

test("send before open emits client error event", () => {
  // Arrange
  const client = createRealtimeClient({
    peerConnectionFactory: () => new FakePeerConnection(),
    session: {
      model: "gpt-realtime",
      type: "realtime"
    },
    sessionEndpoint: "http://localhost/realtime/session"
  });
  const messages: string[] = [];

  client.events$.subscribe((event) => {
    if (isErrorEvent(event)) {
      messages.push(event.error.message);
    }
  });

  // Act
  client.send({ type: "response.create" });

  // Assert
  expect(messages).toEqual(["Cannot send before data channel is open."]);
});

test("invalid outgoing event emits validation error", async () => {
  // Arrange
  const peer = new FakePeerConnection();
  const client = createRealtimeClient({
    fetchImpl: () =>
      Promise.resolve(new Response("answer-sdp", { status: 200 })),
    peerConnectionFactory: () => peer,
    session: {
      model: "gpt-realtime",
      type: "realtime"
    },
    sessionEndpoint: "http://localhost/realtime/session"
  });
  const messages: string[] = [];

  client.events$.subscribe((event) => {
    if (isErrorEvent(event)) {
      messages.push(event.error.message);
    }
  });

  const connectPromise = client.connect();
  const channel = peer.createdChannels.at(0);
  if (channel === undefined) {
    throw new Error("Expected data channel to be created.");
  }
  channel.open();
  await connectPromise;

  // Act
  client.send({ type: "" });

  // Assert
  expect(messages).toContain("Client payload failed validation.");
});

test("setMicrophoneEnabled toggles microphone track state", async () => {
  // Arrange
  const peer = new FakePeerConnection();
  const track: RealtimeMediaStreamTrackLike = {
    enabled: false,
    stop: () => undefined
  };
  const stream: RealtimeMediaStreamLike = {
    getAudioTracks: () => {
      return [track];
    },
    getTracks: () => {
      return [track];
    }
  };

  const client = createRealtimeClient({
    fetchImpl: () =>
      Promise.resolve(new Response("answer-sdp", { status: 200 })),
    getUserMedia: () => Promise.resolve(stream),
    peerConnectionFactory: () => peer,
    session: {
      model: "gpt-realtime",
      type: "realtime"
    },
    sessionEndpoint: "http://localhost/realtime/session"
  });

  const connectPromise = client.connect();
  const channel = peer.createdChannels.at(0);
  if (channel === undefined) {
    throw new Error("Expected data channel to be created.");
  }
  channel.open();
  await connectPromise;

  // Act
  await client.setMicrophoneEnabled(true);
  await client.setMicrophoneEnabled(false);

  // Assert
  expect(peer.addedTracks).toHaveLength(1);
  expect(track.enabled).toBe(false);
});

test("disconnect emits runtime.connection.closed", async () => {
  // Arrange
  const peer = new FakePeerConnection();
  const client = createRealtimeClient({
    fetchImpl: () =>
      Promise.resolve(new Response("answer-sdp", { status: 200 })),
    peerConnectionFactory: () => peer,
    session: {
      model: "gpt-realtime",
      type: "realtime"
    },
    sessionEndpoint: "http://localhost/realtime/session"
  });
  const eventTypes: string[] = [];

  client.events$.subscribe((event) => {
    eventTypes.push(event.type);
  });

  const connectPromise = client.connect();
  const channel = peer.createdChannels.at(0);
  if (channel === undefined) {
    throw new Error("Expected data channel to be created.");
  }
  channel.open();
  await connectPromise;

  // Act
  client.disconnect();

  // Assert
  expect(eventTypes).toContain("runtime.connection.closed");
});

test("parse and guard helpers cover known and unknown events", () => {
  // Arrange
  const delta = parseCoreServerEvent({
    call_id: "call",
    delta: "{}",
    item_id: "fc",
    output_index: 0,
    response_id: "resp",
    type: "response.function_call_arguments.delta"
  });
  const done = parseCoreServerEvent({
    arguments: "{}",
    call_id: "call",
    item_id: "fc",
    output_index: 0,
    response_id: "resp",
    type: "response.function_call_arguments.done"
  });
  const unknown = parseCoreServerEvent({
    foo: "bar",
    type: "custom.event"
  });
  const clientEvent = parseCoreClientEvent({
    response: {},
    type: "response.create"
  });
  const normalizedOutputItemDone = parseCoreServerEvent({
    item: {
      arguments: '{"orderId":"abc123"}',
      call_id: "call_from_output_item",
      name: "lookup_order_eta",
      type: "function_call"
    },
    type: "response.output_item.done"
  });

  // Act
  const unknownNormalized = toUnknownServerEvent(unknown);

  // Assert
  expect(isFunctionCallArgumentsDeltaEvent(delta)).toBe(true);
  expect(isFunctionCallArgumentsDoneEvent(done)).toBe(true);
  expect(isErrorEvent(unknown)).toBe(false);
  expect(isFunctionCallArgumentsDoneEvent(normalizedOutputItemDone)).toBe(true);
  if (!isFunctionCallArgumentsDoneEvent(normalizedOutputItemDone)) {
    throw new Error("Expected normalized output-item done event.");
  }
  expect(normalizedOutputItemDone.call_id).toBe("call_from_output_item");
  expect(normalizedOutputItemDone.name).toBe("lookup_order_eta");
  expect(unknownNormalized.type).toBe("custom.event");
  expect(clientEvent.type).toBe("response.create");
});

test("parseCoreServerEvent normalizes response.output_item.done with optional metadata", () => {
  // Arrange
  const rawEvent = {
    item: {
      arguments: '{"orderId":"abc123"}',
      call_id: "call_full",
      id: "item_full",
      name: "lookup_order_eta",
      type: "function_call"
    },
    output_index: 2,
    response_id: "response_full",
    type: "response.output_item.done"
  };

  // Act
  const parsed = parseCoreServerEvent(rawEvent);

  // Assert
  expect(isFunctionCallArgumentsDoneEvent(parsed)).toBe(true);
  if (!isFunctionCallArgumentsDoneEvent(parsed)) {
    throw new Error("Expected function-call done event.");
  }
  expect(parsed).toEqual({
    arguments: '{"orderId":"abc123"}',
    call_id: "call_full",
    item_id: "item_full",
    name: "lookup_order_eta",
    output_index: 2,
    response_id: "response_full",
    type: "response.function_call_arguments.done"
  });
});

test("parseCoreServerEvent normalizes response.output_item.done without optional metadata", () => {
  // Arrange
  const rawEvent = {
    item: {
      arguments: "{}",
      call_id: "call_minimal",
      type: "function_call"
    },
    type: "response.output_item.done"
  };

  // Act
  const parsed = parseCoreServerEvent(rawEvent);

  // Assert
  expect(isFunctionCallArgumentsDoneEvent(parsed)).toBe(true);
  if (!isFunctionCallArgumentsDoneEvent(parsed)) {
    throw new Error("Expected function-call done event.");
  }
  expect(parsed).toEqual({
    arguments: "{}",
    call_id: "call_minimal",
    type: "response.function_call_arguments.done"
  });
});

test("parseCoreServerEvent parses error envelopes as ErrorEvent", () => {
  // Arrange
  const rawEvent = {
    error: {
      message: "oops",
      type: "server_error"
    },
    type: "error"
  };

  // Act
  const parsed = parseCoreServerEvent(rawEvent);

  // Assert
  expect(isErrorEvent(parsed)).toBe(true);
  if (!isErrorEvent(parsed)) {
    throw new Error("Expected error event.");
  }
  expect(parsed.error.message).toBe("oops");
});

test("done event is enriched with tool name from output_item.added metadata", async () => {
  // Arrange
  const peer = new FakePeerConnection();
  const client = createRealtimeClient({
    fetchImpl: () =>
      Promise.resolve(new Response("answer-sdp", { status: 200 })),
    peerConnectionFactory: () => peer,
    session: {
      model: "gpt-realtime",
      type: "realtime"
    },
    sessionEndpoint: "http://localhost/realtime/session"
  });

  const doneNames: string[] = [];
  client.events$.subscribe((event) => {
    if (isFunctionCallArgumentsDoneEvent(event) && event.name !== undefined) {
      doneNames.push(event.name);
    }
  });

  const connectPromise = client.connect();
  const channel = peer.createdChannels.at(0);
  if (channel === undefined) {
    throw new Error("Expected data channel to be created.");
  }
  channel.open();
  await connectPromise;

  // Act
  channel.emitMessage({
    item: {
      call_id: "call_meta",
      name: "render_ui",
      type: "function_call"
    },
    type: "response.output_item.added"
  });
  channel.emitMessage({
    call_id: "call_meta",
    delta: '{"ui":[]}',
    type: "response.function_call_arguments.delta"
  });
  channel.emitMessage({
    arguments: '{"ui":[]}',
    call_id: "call_meta",
    type: "response.function_call_arguments.done"
  });

  // Assert
  expect(doneNames).toEqual(["render_ui"]);
});

test("parse helpers reject invalid payload shapes", () => {
  // Arrange / Act / Assert
  expect(() => parseCoreServerEvent({})).toThrowError(
    "Server payload is not a valid event envelope."
  );

  expect(() => parseCoreClientEvent({ type: "" })).toThrowError(
    "Client payload is not a valid event envelope."
  );
});

test("send serializes event payload into data channel", async () => {
  // Arrange
  const peer = new FakePeerConnection();
  const client = createRealtimeClient({
    fetchImpl: () =>
      Promise.resolve(new Response("answer-sdp", { status: 200 })),
    peerConnectionFactory: () => peer,
    session: {
      model: "gpt-realtime",
      type: "realtime"
    },
    sessionEndpoint: "http://localhost/realtime/session"
  });

  const connectPromise = client.connect();
  const channel = peer.createdChannels.at(0);
  if (channel === undefined) {
    throw new Error("Expected data channel to be created.");
  }
  channel.open();
  await connectPromise;

  // Act
  client.send({ type: "response.create" });

  // Assert
  expect(channel.sentPayloads).toHaveLength(1);
  const payload = channel.sentPayloads.at(0);
  if (payload === undefined) {
    throw new Error("Expected data channel payload.");
  }
  expect(parsePayloadRecord(payload)).toEqual({
    type: "response.create"
  });
});
