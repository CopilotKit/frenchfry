// @vitest-environment jsdom

import { act, render } from "@testing-library/react";
import { Subject } from "rxjs";
import { createElement } from "react";
import { expect, test, vi } from "vitest";

import { VoiceAgent } from "../src/voice-agent";
import { type VoiceAgentRenderState } from "../src/use-voice-agent";

const connectMock = vi.fn(() => Promise.resolve());
const disconnectMock = vi.fn();
const sendMock = vi.fn();
const setMicrophoneEnabledMock = vi.fn(() => Promise.resolve());

type FakeRealtimeClient = {
  connect: () => Promise<void>;
  disconnect: () => void;
  events$: Subject<{ type: string } & Record<string, unknown>>;
  remoteAudioStream$: Subject<MediaStream>;
  send: () => void;
  setMicrophoneEnabled: (enabled: boolean) => Promise<void>;
  toolCallStarts$: Subject<{
    callId: string;
    itemId: string;
    responseId: string;
    argumentChunks$: Subject<string>;
  }>;
};

const fakeRealtimeClient: FakeRealtimeClient = {
  connect: connectMock,
  disconnect: disconnectMock,
  events$: new Subject(),
  remoteAudioStream$: new Subject(),
  send: sendMock,
  setMicrophoneEnabled: setMicrophoneEnabledMock,
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

/**
 * Creates required session object used by all voice-agent tests.
 *
 * @returns Realtime session config.
 */
const createSession = (): { model: string; type: "realtime" } => {
  return {
    model: "gpt-realtime",
    type: "realtime"
  };
};

test("VoiceAgent remains connecting until runtime.connection.open", () => {
  // Arrange
  let latest: VoiceAgentRenderState | undefined;

  render(
    createElement(VoiceAgent, {
      children: (agent: VoiceAgentRenderState) => {
        latest = agent;
        return null;
      },
      session: createSession(),
      sessionEndpoint: "http://localhost/realtime/session",
      tools: []
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

test("VoiceAgent toggles microphone through setMicrophoneEnabled", async () => {
  // Arrange
  setMicrophoneEnabledMock.mockClear();
  let latest: VoiceAgentRenderState | undefined;

  render(
    createElement(VoiceAgent, {
      children: (agent: VoiceAgentRenderState) => {
        latest = agent;
        return null;
      },
      session: createSession(),
      sessionEndpoint: "http://localhost/realtime/session",
      tools: []
    })
  );

  if (latest === undefined) {
    throw new Error("Expected render state");
  }

  act(() => {
    latest?.start();
  });
  act(() => {
    fakeRealtimeClient.events$.next({
      type: "runtime.connection.open"
    });
  });

  // Act
  await act(async () => {
    await latest?.startVoiceInput();
  });
  act(() => {
    latest?.stopVoiceInput();
  });

  // Assert
  expect(setMicrophoneEnabledMock).toHaveBeenNthCalledWith(1, true);
  expect(setMicrophoneEnabledMock).toHaveBeenNthCalledWith(2, false);
});

test("VoiceAgent startVoiceInput before running reports error", async () => {
  // Arrange
  let latest: VoiceAgentRenderState | undefined;

  render(
    createElement(VoiceAgent, {
      children: (agent: VoiceAgentRenderState) => {
        latest = agent;
        return null;
      },
      session: createSession(),
      sessionEndpoint: "http://localhost/realtime/session",
      tools: []
    })
  );

  if (latest === undefined) {
    throw new Error("Expected render state");
  }

  // Act
  await act(async () => {
    await latest?.startVoiceInput();
  });

  // Assert
  expect(latest?.status).toBe("idle");
  expect(latest?.lastError?.type).toBe("voice_input_error");
});

test("VoiceAgent stop disconnects realtime client", () => {
  // Arrange
  disconnectMock.mockClear();
  let latest: VoiceAgentRenderState | undefined;

  render(
    createElement(VoiceAgent, {
      children: (agent: VoiceAgentRenderState) => {
        latest = agent;
        return null;
      },
      session: createSession(),
      sessionEndpoint: "http://localhost/realtime/session",
      tools: []
    })
  );

  if (latest === undefined) {
    throw new Error("Expected render state");
  }

  // Act
  act(() => {
    latest?.stop();
  });

  // Assert
  expect(disconnectMock).toHaveBeenCalledTimes(1);
  expect(latest?.status).toBe("idle");
});

test("VoiceAgent auto-registers genUi session tool on connection open", () => {
  // Arrange
  sendMock.mockClear();
  const onToolCallDelta = vi.fn();
  const onToolCallDone = vi.fn();
  const onToolCallStart = vi.fn();

  render(
    createElement(VoiceAgent, {
      children: () => null,
      genUi: [
        {
          id: "gen-ui-1",
          onToolCallDelta,
          onToolCallDone,
          onToolCallStart,
          orchestrationTool: {
            description: "Render UI",
            handler: () => Promise.resolve({ accepted: true }),
            name: "render_ui"
          },
          sessionTool: {
            description: "Render UI",
            name: "render_ui",
            parameters: {
              type: "object"
            },
            type: "function"
          }
        }
      ],
      session: createSession(),
      sessionEndpoint: "http://localhost/realtime/session",
      tools: []
    })
  );

  // Act
  act(() => {
    fakeRealtimeClient.events$.next({
      type: "runtime.connection.open"
    });
  });

  // Assert
  expect(sendMock).toHaveBeenCalled();
  expect(sendMock).toHaveBeenCalledWith({
    session: {
      tools: [
        {
          description: "Render UI",
          name: "render_ui",
          parameters: {
            type: "object"
          },
          type: "function"
        }
      ],
      type: "realtime"
    },
    type: "session.update"
  });
});
