# AGENTS.md

Repo-wide agent instructions for `sixb`.

## Scope

- This file applies to the whole repository unless a nearer `AGENTS.md` is added later.
- Keep one root `AGENTS.md` for now. Add nested files only when a package genuinely needs different instructions.

## Repo Map

- `packages/core`: runtime, ontology builders, providers, validation, and functions
- `packages/server`: Elysia HTTP/WebSocket API and OpenAPI generation
- `packages/atlas`: built-in React UI (the Atlas app); pages live in `src/pages/`
- `packages/ui`: shared React component library used by Atlas
- `packages/client`: generated typed client artifacts
- `packages/cli`: CLI entrypoints for `sixb` and `create-sixb`
- `packages/app`: custom app integration
- `connectors/`, `storage/`, `broker/`: integrations and infrastructure providers
- `examples/`: runnable sample projects

## Toolchain

- Bun only for package management, scripts, and runtime. Do not use `npm`, `pnpm`, `yarn`, or Vite CLI commands.
- TypeScript is `strict`, targets ES2022, uses ESNext modules, and `moduleResolution: "bundler"`.
- Formatting and linting are enforced with Biome.
- Prefer `rg` and `rg --files` for search.

## Core Commands

Repo-wide:

```bash
bun install
bun run build
bun run typecheck
bun run test
bun run test:e2e
bun run test:all
bun run check
bun run check:fix
bun run generate:client
bun sixb dev
bun create-sixb
```

Targeted:

```bash
bun --filter @sixb/core build
bun --filter @sixb/core typecheck
bun test packages/core/tests/create-sixb.test.ts
bun test packages/server/tests/
```

CI currently runs:

- `bun install --frozen-lockfile`
- `bun run generate:client`
- `git diff --exit-code`
- `bun run typecheck`
- `bun run build`
- `bun run test`
- package-scoped e2e matrix jobs for packages with `test:e2e`
- `bun run check`

## Architecture

- Define ontology types with `defineObjectType`, `prop`, `link`, `action`, and `defineValueType`.
- Most runtimes start with `createSixb()`.
- `createSixb()` auto-discovers `ontology/`, `datasets/`, `functions/`, `syncs/`, `schedules/`, `pipelines/`, `projections/`, and `connectors/`.
- `sixb.objects(MyType)` is the typed API for object CRUD, telemetry, links, and actions.
- Functions are defined with `defineFunction(id)` and chained with `.interval(...)`, `.cron(...)`, `.broker(...)`, or `.onAction(...)`.
- Important domain events include `object.upserted`, `telemetry.appended`, `link.upserted`, `link.removed`, and `action.requested`.
- Convention-based discovery is the normal registration model.
- Generated client files live in `packages/client/src/generated/`.
- If routes, schemas, or public contracts change, run `bun run generate:client`.

## Code Style

- Biome uses 2 spaces, LF endings, 100 column width, double quotes, ES5 trailing commas, and no semicolons unless required.
- Use `import type` and `export type` for type-only imports and re-exports.
- Prefer explicit public types, but preserve inference where Sixb's typed APIs are designed to carry it.
- Avoid `any`; narrow `unknown` instead of unchecked casts.
- Validate inputs early and throw clear, actionable errors.
- Package-prefixed error messages such as `[Sixb] ...`, `[SixbServer] ...`, or `[RokuTV] ...` are preferred.
- Keep builders and definitions declarative; avoid unnecessary indirection around ontology setup.
- Preserve the existing visual language in `packages/atlas` (and `packages/ui`) and keep both desktop and mobile behavior working.

## Tests

- Test framework is `bun:test`.
- Tests live under `<package>/tests/`.
- Fast tests use `*.test.ts`.
- E2e tests use `*.e2e.ts` and run through `bun run test:e2e`.
- Prefer deterministic tests with temp directories, explicit cleanup, and fixed timestamps.
- Run targeted tests first, then broader checks when shared behavior changes.

## Contribution Flow

- `CONTRIBUTING.md` describes the repo's proposal, approval, async handoff, and merge flow.
- Rough proposals are acceptable. Help shape them toward the clearest outcome and the simplest implementation.
- Issue and PR title patterns are:
  - `Proposal: <desired outcome>`
  - `Task: <small shippable slice>`
  - `<area>: <what changed>`
- AI-authored changes must still be cleaned up, verified, and human-readable before review.

## Local Drafts

- `/.local/` is a gitignored scratchpad for local-only working notes.
- Keep longer-running product or architecture notes in `/.local/bible.md`.
- Put draft proposals, draft specs, and issue writeups in `/.local/drafts/`.
- Treat `/.local/` files as staging material that will usually become GitHub issues, not committed repo docs.
- Only create or commit tracked docs when the content is ready to be shared, referenced, and maintained in the repository.

## Working Norms

- Prefer focused, minimal diffs that match nearby code.
- Read the nearest `package.json`, source files, and tests before editing shared behavior.
- Update docs and tests when behavior or public APIs change.
- Do not switch package managers or add alternate tooling without explicit instruction.
- Do not revert unrelated dirty-worktree changes.
- Avoid destructive git operations unless explicitly requested.

## Quick References

- `packages/core/src/runtime/`: runtime entrypoints
- `packages/core/src/ontology/`: ontology builders and types
- `packages/core/src/functions/`: functions runtime
- `packages/server/src/routes/`: server routes
- `packages/client/src/generated/`: generated client output
- `packages/atlas/src/`: built-in UI (pages in `pages/`, shared components in `packages/ui/src/`)
