# Frenchfry

Frenchfry is a strongly-typed, reactive runtime and UI integration stack for building realtime voice + tool-driven applications on top of the OpenAI Realtime API over WebRTC.

## Warning

This project is entirely experimental and is **not officially supported**. APIs, behavior, and package boundaries may change without notice.

## What It Does

- Provides framework-agnostic client primitives for browser-side Realtime session handling.
- Provides a server runtime boundary for OpenAI connectivity and API-key injection.
- Provides React bindings for voice agents and outlet-based generative UI rendering.
- Demonstrates end-to-end usage with local demo app and demo server packages.

## Repository Layout

```text
packages/
  core/       framework-agnostic frontend connection logic (no UI rendering)
  react/      React bindings built on top of core and Hashbrown UI patterns
  runtime/    server runtime/proxy to OpenAI (including API-key injection boundary)
demos/
  app/        demo React application
  server/     demo server
```

## Packages

- `@frenchfryai/core`
  - Typed Realtime client lifecycle
  - Runtime-validated protocol parsing
  - Tool-call accumulation and execution helpers
- `@frenchfryai/react`
  - `VoiceAgent` orchestration component
  - `FrenchfryProvider`, `VoiceUiOutlet`, and `useGenUi`
- `@frenchfryai/runtime`
  - Typed route registration for Realtime session exchange
  - Validation of external request payloads

## Quickstart

```bash
npm install
npm run demo:dev
```

Create a local `.env` file with your OpenAI credentials and runtime settings before starting demos.

## Quality Gates

```bash
npm run lint
npm run format:check
npm run typecheck
npm run test -- --coverage
npm run build
```
