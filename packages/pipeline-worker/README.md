# @sixb/pipeline-worker

Worker that runs Sixb pipelines.

Dequeues pipeline runs, executes each step in order, and records the run in `storage.pipelineRuns`.
Pipelines are how dataset rows become objects, links, and telemetry, so without this worker running a
pipeline request simply waits in the queue.

## Install

```bash
bun add @sixb/pipeline-worker
```

You normally do not import it. `sixb worker pipeline` and `sixb worker-group` construct it for you,
and that is the supported way to run it.

## Running it yourself

Construct it directly only when you host workers inside your own process:

```ts
import { PipelineWorker } from "@sixb/pipeline-worker"
import { sixb } from "./sixb.config"

const worker = new PipelineWorker(sixb)
await worker.start()
// on shutdown
await worker.stop()
```

Requires a lake storage provider — pipeline steps read dataset versions from it — and a storage
provider with `pipelineRuns` support. Both are checked at construction, so a missing provider fails at
boot rather than on the first job.
