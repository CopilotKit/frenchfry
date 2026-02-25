# @frenchfryai/runtime

Server-side runtime boundary for OpenAI Realtime call setup. This package provides a typed route helper that forwards browser SDP/session payloads to OpenAI and returns answer SDP.

## Installation

```bash
npm install @frenchfryai/runtime hono
```

## What This Package Provides

- `registerRealtimeSessionRoute(...)` for SDP/session exchange endpoint registration
- Input validation for multipart form payloads and session JSON
- Typed runtime protocol parser for browser client events

## Basic Usage

```ts
import { Hono } from "hono";
import { registerRealtimeSessionRoute } from "@frenchfryai/runtime";

const app = new Hono();

registerRealtimeSessionRoute(app, {
  path: "/realtime/session",
  openai: {
    apiKey: process.env.OPENAI_API_KEY ?? ""
  }
});
```

The route expects `multipart/form-data` with:

- `sdp`: offer SDP string
- `session`: JSON string containing at least `{ "type": "realtime", ... }`

## OpenAI Options

- `apiKey`: required
- `callsUrl`: optional override (defaults to `https://api.openai.com/v1/realtime/calls`)
- `organization`: optional OpenAI organization header
- `project`: optional OpenAI project header

## Main Exports

- `registerRealtimeSessionRoute`
- `parseRuntimeClientProtocolEvent`
- `RuntimeOpenAIOptions` type
- `RuntimeRealtimeSessionOptions` type
- `RuntimeClientProtocolEvent` type

