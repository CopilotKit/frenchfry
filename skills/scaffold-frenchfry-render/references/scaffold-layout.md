# Scaffold Layout

## Target structure

```text
<target>/
  package.json
  render.yaml
  apps/
    runtime/
      package.json
      tsconfig.json
      src/index.ts
    web/
      package.json
      tsconfig.json
      vite.config.ts
      index.html
      src/main.tsx
      src/App.tsx
```

## Runtime service checklist

- Use `Hono` server with CORS for web origin.
- Add `/health` endpoint.
- Add `/realtime/session` via `registerRealtimeSessionRoute`.
- Bind server to `0.0.0.0` and `process.env.PORT`.

## React service checklist

- Wrap app with `FrenchfryProvider`.
- Use `VoiceAgent` for connection lifecycle.
- Register at least one `useTool` handler.
- Keep UI minimal; no generated UI outlet by default.
