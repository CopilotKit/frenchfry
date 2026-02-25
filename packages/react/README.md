# @frenchfryai/react

React bindings for Frenchfry voice + tool orchestration, including a high-level `VoiceAgent` component and outlet-based generative UI rendering.

## Installation

```bash
npm install @frenchfryai/react @frenchfryai/core react
```

## What This Package Provides

- `VoiceAgent` for connection lifecycle, tool execution, and render-state
- `FrenchfryProvider` + `VoiceUiOutlet` for outlet-based generated UI delivery
- `useGenUi` to bridge streaming tool args to Hashbrown UI rendering
- `useVoiceAgent` context hook
- Re-exported Hashbrown React helpers: `useTool`, `useUiKit`, `useJsonParser`

## Basic Usage

```tsx
import {
  FrenchfryProvider,
  VoiceAgent,
  VoiceUiOutlet
} from "@frenchfryai/react";

export const App = () => {
  return (
    <FrenchfryProvider>
      <VoiceAgent
        sessionEndpoint="http://localhost:8787/realtime/session"
        session={{ model: "gpt-realtime", type: "realtime" }}
      >
        {(agent) => (
          <>
            <button onClick={agent.start} disabled={agent.isRunning}>
              Start
            </button>
            <button onClick={agent.stop} disabled={!agent.isRunning}>
              Stop
            </button>
            <VoiceUiOutlet name="voice-main" />
          </>
        )}
      </VoiceAgent>
    </FrenchfryProvider>
  );
};
```

## Using `useGenUi`

`useGenUi` registers a tool contract and stream handlers you pass to `VoiceAgent` via `genUi`.

```tsx
import { VoiceAgent, useGenUi } from "@frenchfryai/react";
import { useMyUiKit } from "./my-ui-kit";

export const AgentWithUi = () => {
  const kit = useMyUiKit();
  const genUi = useGenUi({ kit, outlet: "voice-main" });

  return (
    <VoiceAgent
      sessionEndpoint="http://localhost:8787/realtime/session"
      session={{ model: "gpt-realtime", type: "realtime" }}
      genUi={[genUi]}
    >
      {() => null}
    </VoiceAgent>
  );
};
```

## Main Exports

- `FrenchfryProvider`
- `VoiceAgent`
- `VoiceUiOutlet`
- `useGenUi`
- `useVoiceAgent`
- `useTool`
- `useUiKit`
- `useJsonParser`

