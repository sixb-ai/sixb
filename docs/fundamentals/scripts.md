# Scripts

A script is a file you run once against your project: deduplicate records, relink orphaned objects,
backfill a property. It gets the same SDK as an action, with full access, and nothing is
registered or deployed to run it.

## Write a script

Export a function as the file's default export. Put scripts in `scripts/`, or anywhere outside the
[definition folders](project-structure.md#how-files-are-loaded): Sixb imports those, so `sixb run`
refuses a file there.

```ts
// scripts/dedupe-customers.ts
import type { ScriptContext } from "@sixb/core"
import { Customer } from "../ontology/customer"

export default async function ({ sixb, args, signal }: ScriptContext) {
  const dryRun = args.includes("--dry-run")
  const customers = await sixb.objects(Customer).query().list()

  for (const customer of customers) {
    signal.throwIfAborted()
    // ...find duplicates, relink them, delete the extras
  }
}
```

| Field | What it is |
| --- | --- |
| `sixb` | The project's SDK: objects, links, telemetry, actions, workflows, datasets. |
| `args` | Everything after the script's path on the command line, as strings. Parse them yourself. |
| `signal` | Aborts when you press Ctrl-C or the process is stopped, so the script can stop between steps. |

## Run it locally

From the project's directory:

```bash
sixb run scripts/dedupe-customers.ts --dry-run
```

The script runs against the storage in `sixb.config.ts`, the same storage `sixb dev` uses. It
prints what it logs, and `sixb run` exits with `0` when it returns, `1` when it throws, and `130`
when it was stopped. The first Ctrl-C aborts `signal`, and a script that throws because of it, as
`throwIfAborted()` does, counts as stopped. A second Ctrl-C exits at once. Writes the script already
made stay made.

Flags for `sixb` go before the script's path; everything after it goes to the script.

With the in-memory broker and queues of a local setup, a script runs beside `sixb dev`, not inside
it:

- Its changes are saved at once, but rules, live updates and other event subscribers see them only
  when `sixb dev` next picks up pending events, within a minute, or when it next starts.
- It cannot append events of its own with `sixb.events`, which no other process would receive.
- It cannot start workflows, syncs or pipelines, nor can an action it applies, since they would
  wait in a queue nothing reads.

Each of these fails with an error that says so. Do that work from the app or the API, or use a
shared broker and queues, such as `@sixb/broker-redis` and `@sixb/queues-bullmq`. Changes the script
ingests into a dataset are stored, with a warning, and `sixb dev` writes them.

## Run it on your deployment

```bash
sixb run --deployed scripts/dedupe-customers.ts --dry-run
```

This runs the script on the server your [`sixb.deploy.ts`](../deployment/servers.md) deploys to,
with the environment the deployment's services run with. Your production credentials stay on the
server. The script's output, and what `sixb run` prints about it, reach your terminal as one stream,
since the script runs in a terminal there: that is how Ctrl-C reaches it.

- `sixb run` asks before it runs, naming the deployed commit. Pass `--yes` to skip the question;
  without a terminal, such as in CI, `--yes` is required.
- The file is uploaded and runs from its path in the deployed project, so its imports resolve
  against the deployed code. A file it imports that isn't deployed fails to load. If the deployed
  project already has a file at that path with different contents, the run is refused: rename your
  copy, or deploy it.
- Anyone who can [operate the deployment](../deployment/server-access.md) can run scripts on it.
- A deploy and a script never overlap, so neither replaces the code or migrates storage under the
  other. Each waits for the other up to 10 minutes, then fails: run long scripts when nobody is
  deploying, or a deploy started meanwhile, from CI too, fails.
- One run of a given file at a time.
- Closing your terminal or SSH connection stops the script at once, between steps or not. If your
  network drops instead, the server may only notice when its connection times out, and the script
  keeps running until then.
- An exit code of `255` means SSH failed, even if the script itself exited with it.
- The server needs a deploy made with a Sixb version that has `sixb run`. Deploy once after
  upgrading.

## What a script is allowed to do

A script has full access: no permissions or markings are checked. Each run is recorded as its own
execution, and the changes it makes are attributed to the script's path, which is what an object's
history shows.

A script must not run before storage is migrated: `sixb run` stops and tells you to run
`sixb db migrate`.
