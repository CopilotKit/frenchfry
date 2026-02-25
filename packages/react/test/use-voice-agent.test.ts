// @vitest-environment jsdom

import { renderHook } from "@testing-library/react";
import { createElement, type ReactElement, type ReactNode } from "react";
import { expect, test } from "vitest";

import {
  VoiceAgentContext,
  useVoiceAgent,
  type VoiceAgentRenderState
} from "../src/use-voice-agent";

/**
 * Renders children inside a `VoiceAgentContext` provider.
 *
 * @param props Wrapper props.
 * @returns Provider element.
 */
const Wrapper = (props: {
  children: ReactNode;
  value: VoiceAgentRenderState;
}): ReactElement => {
  return createElement(
    VoiceAgentContext.Provider,
    {
      value: props.value
    },
    props.children
  );
};

test("useVoiceAgent returns null without provider", () => {
  // Arrange / Act
  const result = renderHook(() => {
    return useVoiceAgent();
  });

  // Assert
  expect(result.result.current).toBeNull();
});

test("useVoiceAgent returns context value when provider is present", () => {
  // Arrange
  const value: VoiceAgentRenderState = {
    activeToolCalls: [],
    isConnected: true,
    isRunning: true,
    sendEvent: () => {
      return;
    },
    startVoiceInput: () => {
      return Promise.resolve();
    },
    start: () => {
      return;
    },
    status: "running",
    stopVoiceInput: () => {
      return;
    },
    stop: () => {
      return;
    },
    voiceInputStatus: "idle"
  };

  // Act
  const result = renderHook(
    () => {
      return useVoiceAgent();
    },
    {
      wrapper: ({ children }) => {
        return createElement(Wrapper, { children, value });
      }
    }
  );

  // Assert
  expect(result.result.current).toEqual(value);
});
