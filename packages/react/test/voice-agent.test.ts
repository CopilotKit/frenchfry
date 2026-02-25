// @vitest-environment jsdom

import { act, render } from "@testing-library/react";
import { Subject } from "rxjs";
import { createElement } from "react";
import { expect, test, vi } from "vitest";

import { VoiceAgent } from "../src/voice-agent";
import { type VoiceAgentRenderState } from "../src/use-voice-agent";

const connectMock = vi.fn();
const disconnectMock = vi.fn();
const reportToolSuccessMock = vi.fn();
const sendMock = vi.fn();

type FakeRealtimeClient = {
  connect: () => void;
  disconnect: () => void;
  events$: Subject<{ type: string } & Record<string, unknown>>;
  reportToolSuccess: () => void;
  send: () => void;
  toolCallStarts$: Subject<{
    callId: string;
    itemId: string;
    responseId: string;
    argumentChunks$: Subject<string>;
    reportSuccess: () => void;
  }>;
};

const fakeRealtimeClient: FakeRealtimeClient = {
  connect: connectMock,
  disconnect: disconnectMock,
  events$: new Subject(),
  reportToolSuccess: reportToolSuccessMock,
  send: sendMock,
  toolCallStarts$: new Subject()
};

vi.mock("@frenchfryai/core", async () => {
  const actual =
    await vi.importActual<typeof import("@frenchfryai/core")>(
      "@frenchfryai/core"
    );

  return {
    ...actual,
    createRealtimeClient: () => fakeRealtimeClient
  };
});

test("VoiceAgent remains connecting until runtime.connection.open", () => {
  // Arrange
  let latest: VoiceAgentRenderState | undefined;

  render(
    createElement(VoiceAgent, {
      children: (agent: VoiceAgentRenderState) => {
        latest = agent;
        return null;
      },
      tools: [],
      url: "ws://localhost/realtime/ws"
    })
  );

  if (latest === undefined) {
    throw new Error("Expected render state");
  }
  const initialState = latest;

  // Act
  act(() => {
    initialState.start();
  });

  // Assert
  expect(latest?.status).toBe("connecting");
  expect(latest?.isConnected).toBe(false);
  expect(latest?.isRunning).toBe(false);

  // Act
  act(() => {
    fakeRealtimeClient.events$.next({
      type: "runtime.connection.open"
    });
  });

  // Assert
  expect(latest?.status).toBe("running");
  expect(latest?.isConnected).toBe(true);
  expect(latest?.isRunning).toBe(true);
  expect(typeof latest?.startVoiceInput).toBe("function");
  expect(typeof latest?.stopVoiceInput).toBe("function");
  expect(latest?.voiceInputStatus).toBe("idle");
});

test("VoiceAgent stopVoiceInput commits and creates audio-only response", async () => {
  // Arrange
  sendMock.mockClear();
  let latest: VoiceAgentRenderState | undefined;
  const getUserMediaMock = vi.fn().mockResolvedValue({
    getTracks: (): { stop: () => void }[] => []
  });
  const originalAudioContext = globalThis.AudioContext;
  const originalMediaDevices = navigator.mediaDevices;

  class MockAudioContext {
    public sampleRate = 48000;
    public destination = {};

    public close(): Promise<void> {
      return Promise.resolve();
    }

    public createMediaStreamSource(): {
      connect: () => void;
      disconnect: () => void;
    } {
      return {
        connect: () => undefined,
        disconnect: () => undefined
      };
    }

    public createScriptProcessor(): {
      connect: () => void;
      disconnect: () => void;
      onaudioprocess: ((event: unknown) => void) | null;
    } {
      return {
        connect: () => undefined,
        disconnect: () => undefined,
        onaudioprocess: null
      };
    }
  }

  Object.defineProperty(globalThis, "AudioContext", {
    configurable: true,
    value: MockAudioContext
  });
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: {
      getUserMedia: getUserMediaMock
    }
  });

  render(
    createElement(VoiceAgent, {
      children: (agent: VoiceAgentRenderState) => {
        latest = agent;
        return null;
      },
      tools: [],
      url: "ws://localhost/realtime/ws"
    })
  );

  if (latest === undefined) {
    throw new Error("Expected render state");
  }

  // Act
  act(() => {
    latest?.start();
  });
  act(() => {
    fakeRealtimeClient.events$.next({
      type: "runtime.connection.open"
    });
  });
  await act(async () => {
    await latest?.startVoiceInput();
  });
  act(() => {
    latest?.stopVoiceInput();
  });

  // Assert
  expect(sendMock).toHaveBeenNthCalledWith(1, {
    type: "input_audio_buffer.commit"
  });
  expect(sendMock).toHaveBeenNthCalledWith(2, {
    response: {
      modalities: ["audio", "text"]
    },
    type: "response.create"
  });

  Object.defineProperty(globalThis, "AudioContext", {
    configurable: true,
    value: originalAudioContext
  });
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: originalMediaDevices
  });
});

test("VoiceAgent plays assistant response audio deltas", async () => {
  // Arrange
  let latest: VoiceAgentRenderState | undefined;
  const originalAudioContext = globalThis.AudioContext;
  let createBufferCall: { length: number; sampleRate: number } | undefined;
  let copiedSamples: Float32Array | undefined;
  let started = false;

  class MockPlaybackAudioContext {
    public destination = {};
    public state: "running" | "suspended" = "running";

    public close(): Promise<void> {
      return Promise.resolve();
    }

    public resume(): Promise<void> {
      this.state = "running";
      return Promise.resolve();
    }

    public createBuffer(
      channels: number,
      length: number,
      sampleRate: number
    ): {
      getChannelData: (channel: number) => Float32Array;
    } {
      createBufferCall = { length, sampleRate };
      if (channels !== 1) {
        throw new Error("Expected mono channel.");
      }

      const channelData = new Float32Array(length);
      return {
        getChannelData: (channel: number): Float32Array => {
          if (channel !== 0) {
            throw new Error("Expected channel 0.");
          }

          copiedSamples = channelData;
          return channelData;
        }
      };
    }

    public createBufferSource(): {
      buffer: unknown;
      connect: () => void;
      disconnect: () => void;
      onended: (() => void) | null;
      start: () => void;
    } {
      let onended: (() => void) | null = null;

      return {
        buffer: null,
        connect: (): void => undefined,
        disconnect: (): void => undefined,
        get onended() {
          return onended;
        },
        set onended(value: (() => void) | null) {
          onended = value;
        },
        start: (): void => {
          started = true;
          onended?.();
        }
      };
    }
  }

  Object.defineProperty(globalThis, "AudioContext", {
    configurable: true,
    value: MockPlaybackAudioContext
  });

  try {
    render(
      createElement(VoiceAgent, {
        children: (agent: VoiceAgentRenderState) => {
          latest = agent;
          return null;
        },
        tools: [],
        url: "ws://localhost/realtime/ws"
      })
    );

    if (latest === undefined) {
      throw new Error("Expected render state");
    }

    // Act
    act(() => {
      latest?.start();
    });
    act(() => {
      fakeRealtimeClient.events$.next({
        type: "runtime.connection.open"
      });
    });
    act(() => {
      fakeRealtimeClient.events$.next({
        delta: "AAD/fw==",
        sample_rate_hz: 24000,
        type: "response.audio.delta"
      });
    });
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });

    // Assert
    expect(started).toBe(true);
    expect(createBufferCall).toEqual({
      length: 2,
      sampleRate: 24000
    });
    expect(copiedSamples?.length).toBe(2);
    expect(copiedSamples?.[0]).toBe(0);
    expect(copiedSamples?.[1]).toBeCloseTo(1, 3);
  } finally {
    Object.defineProperty(globalThis, "AudioContext", {
      configurable: true,
      value: originalAudioContext
    });
  }
});
