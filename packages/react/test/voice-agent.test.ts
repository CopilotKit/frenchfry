// @vitest-environment jsdom

import { act, render } from "@testing-library/react";
import { Subject } from "rxjs";
import { createElement } from "react";
import { expect, test, vi } from "vitest";

import { VoiceAgent } from "../src/voice-agent";
import { type VoiceAgentRenderState } from "../src/use-voice-agent";

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
  connect: vi.fn(),
  disconnect: vi.fn(),
  events$: new Subject(),
  reportToolSuccess: vi.fn(),
  send: vi.fn(),
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
});
