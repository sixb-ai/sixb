# Contributing to Pario

Pario uses a lightweight, proposal-first workflow for both human contributors and AI-assisted contributors.

The aim is simple:

- make ideas easy to share
- make approved work easy to pick up
- keep feedback loops short
- keep the process lighter than the work

We mostly rely on GitHub issues, assignees, small pull requests, and CI. If the workflow ever feels heavier than the change itself, simplify it.

## Default flow

1. Open a proposal issue for any meaningful change, even if the idea is still rough.
2. Discuss it in the issue until the direction feels clear enough to build.
3. When the team agrees, add the `approved` label.
4. Any approved issue with no assignee is open for anyone to claim.
5. Claim it by assigning yourself and opening a small PR as soon as the first slice is ready.
6. Merge in small slices. If the work grows, split it into follow-up issues or PRs.

## GitHub signals

- Proposal issue: an idea is being shaped.
- `approved`: ready to build.
- No assignee: open to claim.
- Assignee: someone is carrying it.
- Linked PR: active implementation.
- `blocked`: waiting on a decision, dependency, or outside event.
- Merged PR: done.

Recommended labels:

- `approved`
- `blocked`

Everything else should come from the issue, assignee, and linked PR.

## Naming issues and PRs

Keep titles short, specific, and outcome-focused. A good title should tell a teammate what the change is about without opening the thread.

Issue titles:

- `Proposal: <desired outcome>`
- `Task: <small shippable slice>`

Examples:

- `Proposal: simplify createPario auto-discovery`
- `Proposal: add a clearer object action API`
- `Task: add tests for createPario auto-discovery`
- `Task: document action request examples`

PR titles:

- `<area>: <what changed>`

Examples:

- `core: simplify createPario auto-discovery`
- `server: add tests for object action routes`
- `docs: clarify proposal approval flow`

Good titles name the result, not the activity. Prefer `docs: clarify proposal approval flow` over `docs: update docs`.

## Writing a good proposal

A good proposal is short, concrete, and easy to react to.

It should answer:

- What problem are we solving?
- What change do we want?
- What does done look like?
- What is still unclear?

Using AI locally to help draft a proposal is welcome. Before posting it, turn it into a clean issue that another person can understand in a minute or two.

## Proposals start rough

Proposals are not expected to be fully thought out.

The point of opening one is to give the team something real to react to. A good proposal can start as:

- a problem plus a possible direction
- a sketch of an API or workflow
- a note about what feels too complex today
- a first pass that the team can simplify together

The issue is where we shape it into the clearest version and the simplest implementation.

When the direction gets clearer, update the issue body so the latest thinking is easy to find. The discussion can stay messy. The current summary should not.

## Claiming and shipping work

Most approved proposals can be claimed directly.

If an approved issue becomes too large, split it into smaller task issues linked back to the proposal. Use that only when it helps. The goal is flow.

When you take work:

- assign yourself
- open a small PR as soon as the first useful slice is ready
- keep the PR and issue summaries current enough for async review

If you pause or get blocked, leave a short note. If you are stepping away, unassigning yourself helps keep the work available.

## Approval and merge rules

For now, we are a team of three working across France and the US. The rules should stay simple.

An issue is ready for `approved` when:

- the issue body reflects the current direction
- the outcome feels clear enough to implement
- at least one other teammate explicitly agrees
- there are no open blocking objections

A PR is ready to merge when:

- the linked issue is approved, or the change is small and obvious
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

Pario uses Bun, strict TypeScript, and Biome. Follow the repo guidance in [AGENTS.md](./AGENTS.md) and the nearest package.

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

## The feeling we want

Clear proposals. Easy claims. Small PRs. Fast feedback. Small merges. No silent waiting.

That is the experience we are aiming for: steady flow, shared ownership, and a contribution process that feels calm, clear, and energizing.
