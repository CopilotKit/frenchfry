import { createContext, useContext } from "react";

/**
 * Represents a tool call currently tracked by the voice agent.
 */
export type ActiveToolCallState = {
  argumentText: string;
  callId: string;
  itemId: string;
  name?: string;
  responseId: string;
  status: "running" | "streaming";
  updatedAtMs: number;
};

/**
 * Represents the public render-state contract exposed by `VoiceAgent`.
 */
export type VoiceAgentRenderState = {
  activeToolCalls: ActiveToolCallState[];
  isConnected: boolean;
  isRunning: boolean;
  lastError?: {
    message: string;
    type: string;
  };
  sendEvent: (
    event: {
      type: string;
    } & Record<string, unknown>
  ) => void;
  start: () => void;
  status: "connecting" | "error" | "idle" | "running" | "stopping";
  stop: () => void;
};

/**
 * React context carrying the nearest `VoiceAgent` render-state.
 */
export const VoiceAgentContext = createContext<VoiceAgentRenderState | null>(
  null
);

/**
 * Reads the nearest `VoiceAgent` render-state from context.
 *
 * @returns Current voice agent state, or `null` when outside `VoiceAgent`.
 */
export const useVoiceAgent = (): VoiceAgentRenderState | null => {
  return useContext(VoiceAgentContext);
};
