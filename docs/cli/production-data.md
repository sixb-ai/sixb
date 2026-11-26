# Test on production data

Run your git branch locally on a copy of what you can read in production:

```bash
sixb login https://api.example.com   # once, as yourself
sixb dev --from production            # copies on the first run, reuses the copy after
sixb dev --from production --refresh  # takes a new copy, discarding the branch's changes
```

It takes `can.manage(project.source)` in production:

```ts
defineRole("developers", { grantedTo: [developers], grants: [can.manage(project.source)] })
```

## What the branch holds

- **Your copy.** Every object, link, latest telemetry value and member you can read in production,
  at one moment, and nothing you cannot. Its age shows when `sixb dev` starts. A copy of millions
  of objects loads for minutes on its first run: `sixb dev` says so and waits for it.
- **Its own database.** The copy goes into a namespace of the database `sixb.config.ts` uses
  outside production, one per git branch and checkout: a file with SQLite, a schema with
  PostgreSQL. Use a database of your own: anyone who can read it reads your copy. Your changes stay
  until `--refresh`; the copy of a deleted git branch is dropped by the next `sixb dev`. A database
  that cannot keep a branch apart is refused.
- **Production's datasets, read in place.** The datasets you read in full come from production's
  lake as you, cached on your disk. What you write to them stays on the branch. Your project's
  local lake must be DuckLake.
- **You, on this machine.** Every request on the branch runs as you, with your production groups,
  without signing in. The branch listens on this machine only, answers no other host name, and
  refuses requests from web pages it does not serve.
- **Files from production.** Files attached to the objects you copied are read from production,
  as you, wherever the branch reads them: the app, your actions, the agent and its models. This
  takes a production lake that branches can read (DuckLake): the branch's credential comes with
  its datasets. Files the branch writes stay on it.
- **Types fed by a projection** keep updating: a pipeline you change on the branch updates only
  the objects its new rows change. When a type cannot, `sixb dev` says why.

## What is off, and what is not

Refused or off on a branch, each with an error that says so:

- connector calls, OAuth connections, action writebacks and effects, syncs;
- inbound webhooks, invitation and sign-in emails;
- cron schedules (run one on the branch with `sixb schedules run <id> --api-url <the branch's API>`,
  as `sixb dev` prints it; one that starts a sync is refused) and directory checks.

Not refused: your project's own `fetch` calls and the agent's web tools still reach the internet.
A sandbox's [repository access](../sandboxes/overview.md#repository-authentication) works as in
production, except from a connection: with `githubApp` and `access: "write"`, the agent on a branch
can push to the repository, so protect its default branch with branch protection or rulesets.

## What reaches production

`sixb dev` takes the copy with your `sixb login` session (or `SIXB_API_TOKEN`), before the
branch's code runs, and keeps it under `.sixb/branches/`, readable by you only. The branch's code
gets none of that sign-in: it holds only its own credential, which reads production as you for its
objects' files and its datasets, and nothing else. It ends with the copy, or as soon as the
session or token the copy was taken with is signed out or revoked: revoking a leaked token stops
the branches it copied for too. Production runs two
copies at a time per server process, one per person, and records each copy in its log, with your
name, the branch and how you signed in.

On your machine, the branch's code runs as your OS user and could read your `sixb login` session
file: run branches whose code you trust.

## Your project's settings

A branch runs with your project's `dev` values, the environment `sixb dev` always uses: its model
keys and settings. **Never make a `dev` value a production credential.** Connectors and writebacks
are refused on a branch, but your project's own `fetch` calls, its models and the agent's web tools
are not: whatever key a `dev` value holds, the branch's code uses it.
