# Frenchfry Package Reference

## Install from npm

Use published packages (not workspace links) unless user explicitly wants local package development.

Runtime server dependencies:

```bash
npm install @frenchfryai/runtime hono @hono/node-server
```

React client dependencies:

```bash
npm install @frenchfryai/react @hashbrownai/core @hashbrownai/react react react-dom
```

Type support and tooling for React client:

```bash
npm install -D typescript vite @vitejs/plugin-react @types/react @types/react-dom
```

Type support and tooling for runtime server:

```bash
npm install -D typescript tsx
```

## Required runtime behavior

- Expose `/realtime/session` with `registerRealtimeSessionRoute`.
- Pass `OPENAI_API_KEY` through the runtime only.
- Keep browser/client code free of OpenAI API keys.

## Tool-calling focus

- Register tools via `useTool` in the React app.
- Return structured JSON from tools.
- Avoid generated UI wiring (`useGenUi` + `VoiceUiOutlet`) unless explicitly requested.
