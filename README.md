# Frenchfry

Monorepo scaffold for a strongly-typed reactive runtime and UI integration stack.

## Workspace Layout

- `packages/core`: framework-agnostic frontend connection logic
- `packages/react`: React bindings built on top of `core`
- `packages/runtime`: server runtime/proxy boundary
- `demos/app`: Vite + React demo application
- `demos/server`: TypeScript demo server

## Tooling

- TypeScript (strict mode)
- Vite
- Vitest (with coverage thresholds)
- ESLint
- Prettier

## Commands

- `npm run lint`
- `npm run format:check`
- `npm run typecheck`
- `npm run test -- --coverage`
- `npm run build`
