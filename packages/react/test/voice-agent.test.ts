// @vitest-environment jsdom

import { act, render } from "@testing-library/react";
import { Subject } from "rxjs";
import { createElement, useState, type ReactNode } from "react";
import { expect, test, vi } from "vitest";

import { VoiceAgent } from "../src/voice-agent";
import { type VoiceAgentRenderState } from "../src/use-voice-agent";

const connectMock = vi.fn(() => Promise.resolve());
const createRealtimeClientMock = vi.fn();
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

const createFakeRealtimeClient = (): FakeRealtimeClient => {
  return {
    connect: connectMock,
    disconnect: disconnectMock,
    events$: new Subject(),
    remoteAudioStream$: new Subject(),
    send: sendMock,
    setMicrophoneEnabled: setMicrophoneEnabledMock,
    toolCallStarts$: new Subject()
  };
};
let fakeRealtimeClient: FakeRealtimeClient = createFakeRealtimeClient();

vi.mock("@frenchfryai/core", async () => {
  const actual =
    await vi.importActual<typeof import("@frenchfryai/core")>(
      "@frenchfryai/core"
    );

  return {
    ...actual,
    createRealtimeClient: (...args: unknown[]) => {
      createRealtimeClientMock(...args);
      return fakeRealtimeClient;
    }
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
  fakeRealtimeClient = createFakeRealtimeClient();
  createRealtimeClientMock.mockClear();
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
  fakeRealtimeClient = createFakeRealtimeClient();
  createRealtimeClientMock.mockClear();
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
  fakeRealtimeClient = createFakeRealtimeClient();
  createRealtimeClientMock.mockClear();
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
  fakeRealtimeClient = createFakeRealtimeClient();
  createRealtimeClientMock.mockClear();
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
  fakeRealtimeClient = createFakeRealtimeClient();
  createRealtimeClientMock.mockClear();
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

test("VoiceAgent forwards tool argument chunks from toolCallStarts$ to genUi", () => {
  // Arrange
  fakeRealtimeClient = createFakeRealtimeClient();
  createRealtimeClientMock.mockClear();
  const onToolCallDelta = vi.fn();
  const onToolCallDone = vi.fn();
  const onToolCallStart = vi.fn();
  const argumentChunks$ = new Subject<string>();

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
    fakeRealtimeClient.toolCallStarts$.next({
      argumentChunks$,
      callId: "call_stream",
      itemId: "item_stream",
      responseId: "response_stream"
    });
    argumentChunks$.next('{"ui":');
    argumentChunks$.next("[]}");
  });

  // Assert
  expect(onToolCallStart).toHaveBeenCalledWith({
    callId: "call_stream"
  });
  expect(onToolCallDelta).toHaveBeenNthCalledWith(1, {
    callId: "call_stream",
    delta: '{"ui":'
  });
  expect(onToolCallDelta).toHaveBeenNthCalledWith(2, {
    callId: "call_stream",
    delta: "[]}"
  });
  expect(onToolCallDone).not.toHaveBeenCalled();
});

test("VoiceAgent executes a done tool call once for duplicate done events", async () => {
  // Arrange
  fakeRealtimeClient = createFakeRealtimeClient();
  createRealtimeClientMock.mockClear();
  sendMock.mockClear();
  const initialCallCount = sendMock.mock.calls.length;

  render(
    createElement(VoiceAgent, {
      children: () => null,
      session: createSession(),
      sessionEndpoint: "http://localhost/realtime/session",
      tools: [
        {
          description: "Echo",
          handler: (input: unknown) => {
            return Promise.resolve(input);
          },
          name: "echo",
          schema: {
            type: "object"
          }
        }
      ]
    })
  );

  // Act
  await act(async () => {
    fakeRealtimeClient.events$.next({
      arguments: '{"value":1}',
      call_id: "call_dup",
      name: "echo",
      type: "response.function_call_arguments.done"
    });
    fakeRealtimeClient.events$.next({
      arguments: '{"value":1}',
      call_id: "call_dup",
      name: "echo",
      type: "response.function_call_arguments.done"
    });
    await Promise.resolve();
  });

  // Assert
  expect(sendMock.mock.calls.length - initialCallCount).toBe(2);
  expect(sendMock).toHaveBeenNthCalledWith(
    initialCallCount + 1,
    expect.objectContaining({
      type: "conversation.item.create"
    })
  );
  expect(sendMock).toHaveBeenNthCalledWith(
    initialCallCount + 2,
    expect.objectContaining({
      type: "response.create"
    })
  );
});

test("VoiceAgent executes tool call from output-item.done and ignores later duplicate done event", async () => {
  // Arrange
  fakeRealtimeClient = createFakeRealtimeClient();
  createRealtimeClientMock.mockClear();
  sendMock.mockClear();
  const initialCallCount = sendMock.mock.calls.length;

  render(
    createElement(VoiceAgent, {
      children: () => null,
      session: createSession(),
      sessionEndpoint: "http://localhost/realtime/session",
      tools: [
        {
          description: "Echo",
          handler: (input: unknown) => {
            return Promise.resolve(input);
          },
          name: "echo",
          schema: {
            type: "object"
          }
        }
      ]
    })
  );

  // Act
  await act(async () => {
    fakeRealtimeClient.events$.next({
      call_id: "call_output_item_done",
      delta: '{"value":1}',
      type: "response.function_call_arguments.delta"
    });
    fakeRealtimeClient.events$.next({
      item: {
        call_id: "call_output_item_done",
        name: "echo",
        type: "function_call"
      },
      type: "response.output_item.done"
    });
    fakeRealtimeClient.events$.next({
      arguments: '{"value":1}',
      call_id: "call_output_item_done",
      name: "echo",
      type: "response.function_call_arguments.done"
    });
    await Promise.resolve();
  });

  // Assert
  expect(sendMock.mock.calls.length - initialCallCount).toBe(2);
  expect(sendMock).toHaveBeenNthCalledWith(
    initialCallCount + 1,
    expect.objectContaining({
      type: "conversation.item.create"
    })
  );
  expect(sendMock).toHaveBeenNthCalledWith(
    initialCallCount + 2,
    expect.objectContaining({
      type: "response.create"
    })
  );
});

test("VoiceAgent applies output-item-added metadata to active tool call names", () => {
  // Arrange
  fakeRealtimeClient = createFakeRealtimeClient();
  createRealtimeClientMock.mockClear();
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

  // Act
  act(() => {
    fakeRealtimeClient.events$.next({
      call_id: "call_meta",
      delta: '{"x":1}',
      type: "response.function_call_arguments.delta"
    });
  });

  // Assert
  expect(latest?.activeToolCalls.at(0)?.name).toBeUndefined();

  // Act
  act(() => {
    fakeRealtimeClient.events$.next({
      item: {
        call_id: "call_meta",
        name: "lookup_order_eta",
        type: "function_call"
      },
      type: "response.output_item.added"
    });
  });

  // Assert
  expect(latest?.activeToolCalls.at(0)?.name).toBe("lookup_order_eta");
});

test("VoiceAgent uses cached metadata when output-item-added arrives before delta", () => {
  // Arrange
  fakeRealtimeClient = createFakeRealtimeClient();
  createRealtimeClientMock.mockClear();
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

  // Act
  act(() => {
    fakeRealtimeClient.events$.next({
      item: {
        call_id: "call_meta_first",
        name: "render_ui",
        type: "function_call"
      },
      type: "response.output_item.added"
    });
    fakeRealtimeClient.events$.next({
      call_id: "call_meta_first",
      delta: '{"ui":[]}',
      type: "response.function_call_arguments.delta"
    });
  });

  // Assert
  expect(latest?.activeToolCalls.at(0)?.name).toBe("render_ui");
});

test("VoiceAgent does not recreate realtime client for equivalent session objects across rerenders", () => {
  // Arrange
  fakeRealtimeClient = createFakeRealtimeClient();
  createRealtimeClientMock.mockClear();
  let triggerRerender: (() => void) | undefined;

  const Wrapper = (): ReactNode => {
    const [, setTick] = useState(0);
    triggerRerender = () => {
      setTick((value) => value + 1);
    };

    return createElement(VoiceAgent, {
      children: () => null,
      session: {
        model: "gpt-realtime",
        type: "realtime"
      },
      sessionEndpoint: "http://localhost/realtime/session",
      tools: []
    });
  };

  render(createElement(Wrapper));

  if (triggerRerender === undefined) {
    throw new Error("Expected rerender trigger.");
  }

  // Act
  act(() => {
    triggerRerender?.();
  });

  // Assert
  expect(createRealtimeClientMock).toHaveBeenCalledTimes(1);
});
