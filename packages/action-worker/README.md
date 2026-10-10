# @sixb/action-worker

Worker that runs Sixb action jobs from `queues.actions`.

Requesting an action does not enqueue one: `sixb.actions.request(...)` and
`sixb.objects(T).byId(id).requestAction(...)` run the action in the requesting process. This worker
only runs jobs already in the queue, and records each run in `storage.actionRuns`.

## Install

```bash
bun add @sixb/action-worker
```

You normally do not import it. `sixb worker action` and `sixb worker-group` construct it for you, and
that is the supported way to run it.

## Running it yourself

Construct it directly only when you host workers inside your own process:

```ts
import { ActionWorker } from "@sixb/action-worker"
import { sixb } from "./sixb.config"

const worker = new ActionWorker(sixb, { leaseMs: 60_000 })
await worker.start()
// on shutdown
await worker.stop()
```

| Option | Default | Purpose |
| --- | --- | --- |
| `leaseMs` | provider default | How long a claimed job stays invisible to other workers. Set it above your slowest action, or a long action gets picked up twice. |

Requires a storage provider with `actionRuns` support and, for actions that read or write files, a
blob storage provider. Both are checked at construction, so a missing provider fails at boot rather
than on the first job.
