# Contributing to Sixb

Sixb uses a lightweight, idea-first workflow for both human contributors and AI-assisted contributors.

The aim is simple:

- make ideas easy to share and review
- make approved work easy to pick up
- keep feedback loops short
- keep the process lighter than the work

We mostly rely on GitHub issues, assignees, small pull requests, and CI. If the workflow ever feels heavier than the change itself, simplify it.

## Default flow

1. Open an issue for any meaningful idea with the `idea` and `status:draft` labels.
2. When the issue body is ready for team feedback, replace `status:draft` with `status:review`.
3. Discuss it in the issue until the direction feels clear enough to build.
4. When the team agrees, replace `status:review` with `status:approved`.
5. Any approved idea with no assignee is open for anyone to claim.
6. Claim it by assigning yourself and opening a small PR as soon as the first slice is ready.
7. When the work is finished, replace the current status with `status:completed` and close the
   issue. Merge in small slices, splitting follow-up issues or PRs when useful.

## GitHub signals

- `idea`: classifies an issue as an idea rather than its lifecycle stage.
- `status:draft`: the idea is still being written or shaped by its author.
- `status:review`: the idea is ready for team feedback and a decision.
- `status:approved`: the direction is agreed and ready to build.
- `status:completed`: the work is finished and the issue is closed.
- No assignee: open to claim.
- Assignee: someone is carrying it.
- Linked PR: active implementation.
- Merged PR: done.

Every issue labeled `idea` should have exactly one lifecycle label:

- `status:draft`
- `status:review`
- `status:approved`
- `status:completed`

Everything else should come from the issue, assignee, and linked PR.

## Naming issues and PRs

Keep titles short, specific, and outcome-focused. A good title should tell a teammate what the change is about without opening the thread.

Issue titles:

- `Idea: <desired outcome>`
- `Task: <small shippable slice>`

Examples:

- `Idea: simplify createSixb auto-discovery`
- `Idea: add a clearer object action API`
- `Task: add tests for createSixb auto-discovery`
- `Task: document action request examples`

PR titles:

- `<area>: <what changed>`

Examples:

- `core: simplify createSixb auto-discovery`
- `server: add tests for object action routes`
- `docs: clarify idea review flow`

Good titles name the result, not the activity. Prefer `docs: clarify idea review flow` over
`docs: update docs`.

## Writing a good idea

A good idea is short, concrete, and easy to react to.

It should answer:

- What problem are we solving?
- What change do we want?
- What does done look like?
- What is still unclear?

Using AI locally to help draft an idea is welcome. Before moving it to `status:review`, make the
issue understandable to another person in a minute or two.

## Ideas start rough

Ideas are not expected to be fully thought out.

The point of opening one is to give the team something real to react to. A good draft can start as:

- a problem plus a possible direction
- a sketch of an API or workflow
- a note about what feels too complex today
- a first pass that the team can simplify together

The issue is where we shape it into the clearest version and the simplest implementation.

When the direction gets clearer, update the issue body so the latest thinking is easy to find. The discussion can stay messy. The current summary should not.

## Claiming and shipping work

Most approved ideas can be claimed directly.

If an approved issue becomes too large, split it into smaller task issues linked back to the idea.
Use that only when it helps. The goal is flow.

When you take work:

- assign yourself
- open a small PR as soon as the first useful slice is ready
- keep the PR and issue summaries current enough for async review

If you pause or get blocked, leave a short note. If you are stepping away, unassigning yourself helps keep the work available.

## Approval and merge rules

For now, we are a team of three working across France and the US. The rules should stay simple.

An issue is ready for `status:approved` when:

- the issue body reflects the current direction
- the outcome feels clear enough to implement
- at least one other teammate explicitly agrees
- there are no open blocking objections

A PR is ready to merge when:

- the linked issue has `status:approved`, or the change is small and obvious
- CI passes
- at least one other teammate approves
- blocking comments are resolved
- the PR is small enough to review quickly

For non-urgent changes, prefer to leave a ready PR open through at least one timezone handoff so someone on the other side of the Atlantic has a fair chance to review.

As the team grows, we can tighten or expand these rules. For now, clarity and momentum matter more than ceremony.

## Async-friendly habits

This project should work smoothly across time zones.

- Keep the latest decision in GitHub, not only in chat.
- Prefer short summary comments over long back-and-forth threads.
- Ask specific questions, and include a recommendation when helpful.
- Prefer small PRs that are easy to review and easy to merge.
- Use follow-up issues instead of holding a PR for every nice-to-have.

## AI-assisted contributions

AI is welcome for drafting specs, exploring options, writing code, improving tests, and polishing docs.

The bar is the same as any other contribution:

- review and clean up the output
- make the final issue and PR readable to humans
- verify behavior, tests, generated files, and edge cases
- keep ownership with the person submitting or merging the change

If an AI author is working inside the repository, it should also follow [AGENTS.md](./AGENTS.md).

## Repository expectations

Sixb uses Bun, strict TypeScript, and Biome. Follow the repo guidance in [AGENTS.md](./AGENTS.md) and the nearest package.

Before marking a PR ready for review, run the checks that match your change. Common commands are:

```bash
bun run test
bun run typecheck
bun run build
bun run check
```

If you change server routes, schemas, or generated client contracts, also run:

```bash
bun run generate:client
```

Prefer targeted checks while iterating, then broader checks before review.

## Versioning

Publishable packages are versioned independently. A package manifest is its release intent: bump the
packages that should ship and leave unrelated manifests alone. The publisher reads registry state
before its first write, publishes only local versions that do not exist yet, and keeps dependency
order across that smaller plan.

### Workspace dependencies

Bun resolves workspace protocols when packing. Use:

- `dependencies` with `workspace:^` for compatible public package APIs.
- `peerDependencies` with `workspace:^` for connectors and providers that use public core. Add
  `devDependencies` with `workspace:*` for local development.
- Exact `workspace:*` peers for packages that import `@sixb/core/internal/*`. The CLI also pins core
  and the internal runtime packages it owns exactly.

For example, a provider declares core as a compatible peer while developing against the workspace
version:

```json
{
  "peerDependencies": {
    "@sixb/core": "workspace:^"
  },
  "devDependencies": {
    "@sixb/core": "workspace:*"
  }
}
```

Changing a dependency field or protocol requires a package version bump. Core changes also require
exact consumers to bump; compatible caret consumers release only when their published range no
longer matches. `bun run test:publish` and the release planner enforce these rules.

The `create-sixb` template keeps one explicit registry range per Sixb dependency. Do not derive
those ranges from the `create-sixb` version: independently-versioned packages may cross a
compatibility boundary at different times. The publish gate rejects only the stale template range.

The `0.0.x` line is for public validation. Publish those versions only under npm's `next` tag and
increment the patch for every new artifact: npm versions are immutable. The `latest` tag is reserved
for `0.1.0`, the first minimally stable, tested release, and later versions.

Preview the selective plan first. Releasing itself remains two commands: the first produces and
verifies every package artifact; the second publishes the plan in dependency order. Existing package
versions are skipped so an interrupted run can be re-run:

```bash
bun run release:plan -- --tag next
bun run release
bun run release:publish -- --tag next
```

For a passkey or security key, authenticate through the browser and keep the publisher interactive
so every `bun publish` can expose its WebAuthn challenge:

```bash
bunx npm login --auth-type=web
bun run release:publish -- --tag next --auth-type web
```

The publisher gives the child process direct terminal access in this mode. A failed or interrupted
challenge is safe to resume: re-run the command and versions already on the registry are skipped.

The tag changes how npm resolves an install, not the package version: consumers opt into previews
with `bun add @sixb/core@next` or `bunx create-sixb@next my-app`. Publishing another preview moves
`next` forward without making it the default install.

For `0.1.0` and later, publish to `next` first, verify it, then move those immutable package versions
to `latest`. Authenticate once through npm's web flow, inspect the complete promotion plan, then run
the promotion:

```bash
bunx npm login --auth-type=web
bun run release:promote -- --plan
bun run release:promote
```

npm exposes one dist-tag write per package rather than an atomic workspace promotion. The command
performs those writes in series using the existing npm login, but validates the entire workspace
before the first write. It promotes only local versions staged under `next`, verifies every resulting
`latest` tag, skips packages already promoted, and is therefore safe to resume after an interruption.
The release tooling refuses to publish a `0.0.x` version directly to `latest` or to move `next` or
`latest` to an older SemVer.

Bun assigns `latest` on a package's first publication even when `--tag next` is requested. The
publisher therefore lists but defers packages that do not exist on the registry yet, while staging
independent existing packages normally. Rehearse each bootstrap against a local registry using
`--tag latest`, and publish it publicly only when it is ready to become the default install. A
dependent release remains blocked until its new dependency is available. Later releases use the
normal `next` flow. Note that `bun publish --dry-run` still authenticates; to rehearse without
credentials, point `--registry` at a local registry.

## The feeling we want

Clear ideas. Easy claims. Small PRs. Fast feedback. Small merges. No silent waiting.

That is the experience we are aiming for: steady flow, shared ownership, and a contribution process that feels calm, clear, and energizing.
