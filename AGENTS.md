# AGENTS.md

This file defines the default engineering rules for this repository and everything under it.

## Project Purpose

Frenchfry is a riff on liveloveapp/hashbrown.

Its purpose is to provide a strongly-typed, reactive agent runtime and UI integration stack for building realtime voice + tool-driven applications on top of OpenAI Realtime API over WebRTC. The system should let agents call tools that can render UI elements, with a framework-agnostic core and ergonomic framework bindings.

## Repository Structure

```text
packages/
  core/       framework-agnostic frontend connection logic (no UI rendering)
  react/      React bindings built on top of core and Hashbrown UI patterns
  runtime/    server runtime/proxy to OpenAI (including API-key injection boundary)
demos/
  app/        demo React application
  server/     demo server
.env          local OpenAI API key and local runtime configuration
```

Notes:

- `packages/*` are publishable npm packages.
- Keep cross-package boundaries explicit; do not leak UI concerns into `packages/core`.
- `packages/runtime` owns server-side side-effect boundaries for OpenAI connectivity concerns.

## Core Principles

- Use strict TypeScript and prove correctness through strong, explicit types.
- Favor functional programming with small, composable, single-purpose functions.
- Isolate side effects.
- Model side-effect orchestration with idiomatic RxJS.
- Refactor aggressively toward this target architecture when relevant to the task.

## TypeScript Requirements

- TypeScript must be configured and used in strict mode.
- Treat the following as hard requirements:
  - `strict: true`
  - `noImplicitAny: true`
  - `exactOptionalPropertyTypes: true`
- Do not use `any`.
- Do not use type assertions unless they are a narrow, documented escape hatch.
- Use exhaustive union handling with `never` checks.
- Prefer type-level modeling that makes invalid states unrepresentable.

## Functional + Reactive Patterns

- Prefer function composition over shared mutable state.
- Keep core logic pure.
- Never throw from core logic.
- If exceptions are necessary, isolate them to side-effect boundaries.
- Use RxJS idiomatically for side effects and async workflows.
- Avoid manual `subscribe()` in application logic where composition/effects can be used.
- Do not use nested subscriptions.
- Keep streams cold by default; document hot/shared streams explicitly.
- Model state using an event/reducer pattern in RxJS pipelines.

## State and Mutation

- Treat state as immutable by default.
- Do not mutate function inputs.
- Disallow in-place mutation except for performance-critical, local-only mutation.
- Any permitted local mutation must include clear TSDoc justification.
- Do not rely on pervasive `readonly` typing as a blanket rule.

## TSDoc

- Every function must have TSDoc, including internal/private functions.
- TSDoc should capture purpose, inputs, outputs, side effects, and error behavior.

## Imports and Modules

- Prefer named exports.
- Path aliases are allowed when they point to the root of a library/module boundary.
- Sort imports with this order:
  - path-alias imports first (sorted)
  - relative imports second (sorted)

## Runtime Validation

- Validate all external input boundaries at runtime.
- External boundaries include HTTP, database IO, queues/events, environment variables, and other untyped inputs.
- Prefer `zod@4` for boundary validation.
- Keep internal logic driven by static types after boundary validation.

## Dependency Policy

- Prefer standard library and existing dependencies first.
- New dependencies require clear justification in PR/task notes.

## Git Commit Conventions

- Always use Conventional Commits for commit messages.
- Follow the format: `type(scope): summary`
- Use lowercase commit types such as `feat`, `fix`, `docs`, `refactor`, `test`, `chore`.

## Testing Requirements

- Use `vitest`.
- TDD is required for new logic:
  - write a failing test first
  - run tests to confirm failure
  - implement code
  - run tests to confirm passing
- Unit tests are required for all new logic.
- Use `test(...)` style only.
- Do not use `describe`, `beforeEach`, `it`, or similar block-style APIs.
- Structure tests clearly with Arrange / Act / Assert sections.
- Mock only at side-effect boundaries (network, filesystem, time, randomness, process/env, etc.).
- Prefer real collaborators for pure/internal logic.
- Coverage goal is high confidence with enforced minimums:
  - 95% lines
  - 95% branches
  - 95% functions
  - 95% statements

## Quality Gates

Before considering work complete, all of the following must pass:

- lint
- format check
- typecheck
- unit tests
- coverage thresholds
- build

Preferred script contract (npm):

- `npm run lint`
- `npm run format:check`
- `npm run typecheck`
- `npm run test -- --coverage`
- `npm run build`

If scripts are missing, add/update scripts to satisfy this contract as part of the task.
