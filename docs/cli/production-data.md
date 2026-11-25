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
  at one moment, and nothing you cannot. Its age shows when `sixb dev` starts.
- **Its own database.** The copy goes into a namespace of the database `sixb.config.ts` uses
  outside production, one per git branch and checkout: a file with SQLite, a schema with
  PostgreSQL. Use a database of your own: anyone who can read it reads your copy. Your changes stay
  until `--refresh`; the copy of a deleted git branch is dropped by the next `sixb dev`. A database
  that cannot keep a branch apart is refused.
- **Production's datasets, read in place.** The datasets you read in full come from production's
  lake as you, cached on your disk. What you write to them stays on the branch. Your project's
  local lake must be DuckLake.
- **You, on this machine.** Every request on the branch runs as you, with your production groups,
  without signing in; the branch listens on this machine only, and answers no other host name.
- **Files from production.** Files attached to objects are read from production, as you.
- **Types fed by a projection** keep updating: a pipeline you change on the branch updates only
  the objects its new rows change. When a type cannot, `sixb dev` says why.

## What is off, and what is not

Refused or off on a branch, each with an error that says so:

- connector calls, OAuth connections, action writebacks and effects, syncs;
- inbound webhooks, invitation and sign-in emails;
- cron schedules (run one on the branch with `sixb schedules run <id> --api-url <the branch's API>`,
  as `sixb dev` prints it) and directory checks.

Not refused: your project's own `fetch` calls and the agent's web tools still reach the internet.

## What reaches production

`sixb dev` takes the copy with your `sixb login` session, before the branch's code runs. The
branch itself holds only its own credential, which reads production as you for its objects' files
and its datasets, and nothing else; it ends with the copy. Production records each copy in its
log and your activity.

On your machine, the branch's code runs as your OS user and could read your `sixb login` session
file: run branches whose code you trust. Hosted branches keep the stricter guarantee.
