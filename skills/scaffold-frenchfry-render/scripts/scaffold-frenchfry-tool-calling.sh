#!/usr/bin/env bash
set -euo pipefail

# Scaffold a two-service Frenchfry project:
# - apps/runtime: Hono + @frenchfryai/runtime proxy for Realtime session creation
# - apps/web: Vite + React + @frenchfryai/react tool-calling demo

TARGET_DIR="${1:-frenchfry-tool-calling-app}"

if [ -e "$TARGET_DIR" ]; then
  echo "Target already exists: $TARGET_DIR" >&2
  exit 1
fi

mkdir -p "$TARGET_DIR"
cd "$TARGET_DIR"

cat > package.json <<'JSON'
{
  "name": "frenchfry-tool-calling-app",
  "private": true,
  "type": "module",
  "workspaces": [
    "apps/*"
  ],
  "scripts": {
    "dev": "npm run dev -w @app/runtime & npm run dev -w @app/web & wait",
    "build": "npm run build -ws"
  }
}
JSON

mkdir -p apps/runtime/src apps/web/src

cat > apps/runtime/package.json <<'JSON'
{
  "name": "@app/runtime",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "start": "tsx src/index.ts",
    "build": "tsc --noEmit"
  },
  "dependencies": {
    "@frenchfryai/runtime": "latest",
    "@hono/node-server": "^1.19.5",
    "hono": "^4.12.2"
  },
  "devDependencies": {
    "@types/node": "^22.18.1",
    "tsx": "^4.20.5",
    "typescript": "^5.9.2"
  }
}
JSON

cat > apps/runtime/tsconfig.json <<'JSON'
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noImplicitAny": true,
    "exactOptionalPropertyTypes": true,
    "esModuleInterop": true,
    "types": ["node"],
    "skipLibCheck": true
  },
  "include": ["src"]
}
JSON

cat > apps/runtime/src/index.ts <<'TS'
import { serve } from "@hono/node-server";
import { registerRealtimeSessionRoute } from "@frenchfryai/runtime";
import { Hono } from "hono";
import { cors } from "hono/cors";

const app = new Hono();
const port = Number(process.env.PORT ?? "8787");
const appOrigin = process.env.APP_ORIGIN ?? "http://localhost:5173";

app.use("/realtime/session", cors({ origin: appOrigin }));
app.use("/config", cors({ origin: appOrigin }));

app.get("/health", (context) => {
  return context.json({ ok: true });
});

app.get("/config", (context) => {
  return context.json({
    realtimeSessionUrl: `http://localhost:${port}/realtime/session`
  });
});

registerRealtimeSessionRoute(app, {
  path: "/realtime/session",
  openai: {
    apiKey: process.env.OPENAI_API_KEY ?? ""
  }
});

serve({
  fetch: app.fetch,
  hostname: "0.0.0.0",
  port
});
TS

cat > apps/web/package.json <<'JSON'
{
  "name": "@app/web",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "vite build"
  },
  "dependencies": {
    "@frenchfryai/react": "latest",
    "@hashbrownai/core": "0.5.0-beta.4",
    "@hashbrownai/react": "0.5.0-beta.4",
    "react": "^19.0.0",
    "react-dom": "^19.0.0"
  },
  "devDependencies": {
    "@types/react": "^19.0.12",
    "@types/react-dom": "^19.0.4",
    "@vitejs/plugin-react": "^4.3.4",
    "typescript": "^5.9.2",
    "vite": "^7.1.2"
  }
}
JSON

cat > apps/web/tsconfig.json <<'JSON'
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "jsx": "react-jsx",
    "strict": true,
    "noImplicitAny": true,
    "exactOptionalPropertyTypes": true,
    "skipLibCheck": true
  },
  "include": ["src"]
}
JSON

cat > apps/web/vite.config.ts <<'TS'
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()]
});
TS

cat > apps/web/index.html <<'HTML'
<!doctype html>
<html>
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Frenchfry Tool Calling</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
HTML

cat > apps/web/src/main.tsx <<'TS'
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App";

const root = document.getElementById("root");
if (root === null) {
  throw new Error("Missing #root");
}

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>
);
TS

cat > apps/web/src/App.tsx <<'TSX'
import {
  FrenchfryProvider,
  VoiceAgent,
  useTool
} from "@frenchfryai/react";
import { s } from "@hashbrownai/core";
import { type ReactElement } from "react";

const ToolCallingAgent = (): ReactElement => {
  useTool({
    name: "lookup_status",
    description: "Get a hard-coded service status by service name.",
    parameters: {
      service: s.string("Service name")
    },
    render: ({ service }) => {
      const normalized = String(service).toLowerCase();
      const status = normalized.includes("api") ? "healthy" : "watch";
      return { service, status };
    }
  });

  return (
    <VoiceAgent
      sessionEndpoint="http://localhost:8787/realtime/session"
      session={{ type: "realtime", model: "gpt-realtime" }}
    >
      {(agent) => {
        return (
          <section style={{ fontFamily: "sans-serif", margin: "2rem auto", maxWidth: 640 }}>
            <h1>Frenchfry Tool Calling</h1>
            <p>Focus: tool calling with a local tool, not generative UI outlets.</p>
            <button onClick={agent.start} disabled={!agent.canConnect} type="button">
              Connect
            </button>
            <button
              onClick={agent.stop}
              disabled={!agent.canDisconnect}
              style={{ marginLeft: 12 }}
              type="button"
            >
              Disconnect
            </button>
            <p>Status: {agent.status}</p>
            <p>Voice Input: {agent.voiceInputStatus}</p>
          </section>
        );
      }}
    </VoiceAgent>
  );
};

export const App = (): ReactElement => {
  return (
    <FrenchfryProvider>
      <ToolCallingAgent />
    </FrenchfryProvider>
  );
};
TSX

cat > render.yaml <<'YAML'
services:
  - type: web
    name: frenchfry-runtime
    runtime: node
    plan: free
    region: oregon
    branch: main
    autoDeploy: true
    rootDir: .
    buildCommand: npm ci && npm run build -w @app/runtime
    startCommand: npm run start -w @app/runtime
    healthCheckPath: /health
    envVars:
      - key: NODE_ENV
        value: production
      - key: APP_ORIGIN
        value: https://frenchfry-web.onrender.com
      - key: OPENAI_API_KEY
        sync: false

  - type: web
    name: frenchfry-web
    runtime: static
    plan: free
    region: oregon
    branch: main
    autoDeploy: true
    rootDir: apps/web
    buildCommand: npm ci && npm run build
    staticPublishPath: ./dist
    routes:
      - type: rewrite
        source: /*
        destination: /index.html
    envVars:
      - key: VITE_RUNTIME_URL
        value: https://frenchfry-runtime.onrender.com
YAML

npm install

echo "Scaffold complete: $TARGET_DIR"
echo "Next: set OPENAI_API_KEY and run npm run dev"
