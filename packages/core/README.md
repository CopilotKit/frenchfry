# @frenchfryai/core

Framework-agnostic primitives for OpenAI Realtime over WebRTC, with typed event parsing and tool-call orchestration helpers.

## Installation

```bash
npm install @frenchfryai/core
```

## What This Package Provides

- `createRealtimeClient(...)` to manage browser-side realtime connection lifecycle
- Runtime-validated protocol parsers for client/server events
- Tool-call stream accumulation and invocation utilities
- Structured tool output helpers for `function_call_output` events

## Basic Usage

```ts
import { createRealtimeClient } from "@frenchfryai/core";

const client = createRealtimeClient({
  sessionEndpoint: "http://localhost:8787/realtime/session",
  session: {
    model: "gpt-realtime",
    type: "realtime"
  }
});

await client.connect();

client.events$.subscribe((event) => {
  if (event.type === "runtime.connection.open") {
    console.log("connected");
  }
});

client.send({
  type: "response.create",
  response: {}
});
```

## Tool Orchestration Example

```ts
import {
  createFunctionCallOutputEvents,
  createToolRegistry,
  runToolInvocation
} from "@frenchfryai/core";

const toolsByName = createToolRegistry([
  {
    name: "echo",
    description: "Echo input",
    handler: async (input) => input
  }
]);

const result = await runToolInvocation({
  doneEvent: {
    type: "response.function_call_arguments.done",
    call_id: "call_123",
    name: "echo",
    arguments: "{\"hello\":\"world\"}"
  },
  timeoutMs: 15_000,
  toolsByName
});

const outputEvents = createFunctionCallOutputEvents({
  callId: result.callId,
  output: result.output
});
```

## Main Exports

- `createRealtimeClient`
- `parseCoreClientEvent`
- `parseCoreServerEvent`
- `createToolCallAccumulatorState`
- `reduceToolCallAccumulatorState`
- `createToolRegistry`
- `runToolInvocation`
- `shouldInvokeToolCall`
- `createFunctionCallOutputEvents`

