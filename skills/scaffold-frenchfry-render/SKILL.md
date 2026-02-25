---
name: scaffold-frenchfry-render
description: Scaffold a Frenchfry voice app with runtime and React clients focused on tool calling (not generative UI), install published Frenchfry npm packages, and generate a complete Render Blueprint (`render.yaml`) for deployment. Use when users ask to bootstrap Frenchfry projects, set up @frenchfryai/runtime + @frenchfryai/react from npm, or prepare Render deployment configuration.
---

# Scaffold Frenchfry Render

## Overview

Use this skill to bootstrap a Frenchfry project with:
- Runtime proxy (`@frenchfryai/runtime`) for Realtime session creation.
- React client (`@frenchfryai/react`) for voice + tool-calling UX.
- Render Blueprint (`render.yaml`) for deployment.

Keep scope focused on tool calling. Do not add generative UI outlets unless explicitly requested.

## Workflow

1. Confirm scaffold target.
- Confirm output directory name.
- Confirm whether to use the bundled scaffold script or manual patching.

2. Scaffold project.
- Preferred:
```bash
bash skills/scaffold-frenchfry-render/scripts/scaffold-frenchfry-tool-calling.sh <target-dir>
```
- This creates runtime + web apps, installs dependencies, and writes a starter `render.yaml`.

3. Validate Frenchfry npm package installation.
- Ensure these packages are present:
  - `@frenchfryai/runtime`
  - `@frenchfryai/react`
- Confirm install status:
```bash
npm ls @frenchfryai/runtime @frenchfryai/react
```

4. Verify app wiring.
- Runtime app must expose `/realtime/session` via `registerRealtimeSessionRoute`.
- React app must register at least one tool using `useTool`.
- Keep implementation focused on tool calls; avoid `useGenUi` / `VoiceUiOutlet` by default.

5. Build Render Blueprint.
- Start from `assets/frenchfry-tool-calling-render.yaml`.
- Reconcile with full Render guidance in `references/render-deploy/`.
- Include both services:
  - Node web service for runtime
  - Static web service for React app
- Ensure secrets use `sync: false` and public config values use `value`.

6. Final checks.
- Verify `OPENAI_API_KEY` is declared in `render.yaml` with `sync: false`.
- Verify runtime binds to `0.0.0.0:$PORT`.
- Verify static service rewrites `/*` to `/index.html`.

## Render Reference Map

Use these copied Render skill resources directly:
- `references/render-deploy/blueprint-spec.md`
- `references/render-deploy/configuration-guide.md`
- `references/render-deploy/service-types.md`
- `references/render-deploy/deployment-details.md`
- `references/render-deploy/post-deploy-checks.md`
- `assets/render-deploy-blueprints/*.yaml`

Read only what is needed for the user’s requested stack.

## Output Contract

When done, produce:
- Runtime service source files.
- React app source files with tool-calling example.
- `render.yaml` with both services and env vars.
- Commands used to install npm dependencies.
