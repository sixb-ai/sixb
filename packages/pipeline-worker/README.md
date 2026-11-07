# @sixb/pipeline-worker

Worker that runs Sixb pipelines.

Dequeues pipeline runs, executes each step in order, and records the run in `storage.pipelineRuns`.
Pipelines are how datasets become other datasets, so without this worker running a pipeline request
simply waits in the queue.

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

## Recovery

Each step commits one lake version, and a run can stop anywhere between them. `RunWorker` claims the
run ([how](../core/src/workers/README.md)), and a run that resumes goes through its steps in order:

| Step on record | Then |
| --- | --- |
| `succeeded` | Skipped: its output stands |
| `running`, and its version is in the lake | Recorded, not run again, and its version announced |
| `running`, and no version | Run again on the current inputs |
| `failed` or `cancelled` | Ends the run: the crash came after the step decided it |
| None | Run |

A step captures its output guard before it looks for its own version, so a commit it does not find
cannot land unnoticed. That is what keeps an `append` output from being written twice. A step that
fails asks the lake too, because a commit can land and still answer with an error, and if the lake
cannot say the run stays open for the next delivery. A step that really failed fails the run for
good: only a run whose worker went away resumes.

A run does not pin the definition it started under. Steps are found on record by step id, so a deploy
can insert or move one and what committed stands; a step the deploy removed ends `cancelled`, and a
step it added runs.
