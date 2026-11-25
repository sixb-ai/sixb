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
  outside production, one per git branch: a file with SQLite, a schema with PostgreSQL. Your
  changes stay there until `--refresh`; the copy of a deleted git branch is dropped by the next
  `sixb dev`. A database that cannot keep a branch apart is refused.
- **Production's datasets, read in place.** The datasets you read in full come from production's
  lake through production, as you, and are cached on your disk. What you write to them stays on
  the branch. Your project's local lake must be DuckLake.
- **You, signed in.** Every request on the branch runs as you, with your production groups. Files
  attached to objects are read through production, as you.
- **Types fed by a projection** keep updating: a pipeline you change on the branch updates only
  the objects its new rows change. When a type cannot, `sixb dev` says why.

## What is off

Nothing on a branch reaches outside it: connector calls, action writebacks and effects, syncs,
inbound webhooks, invitation and sign-in emails, cron schedules and directory checks are refused
or off, with an error that says so. Run a cron schedule by hand with `sixb schedules run <id>`.

Production records each copy in its activity.
