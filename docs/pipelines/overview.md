# Pipelines

A pipeline transforms [datasets](../datasets/overview.md). Reach for one after a [sync](../syncs/overview.md) lands raw
source rows that need to be cleaned, filtered, reshaped, joined, or made ready for a
[projection](../projections/overview.md).

A pipeline is a sequence of **steps**. Each step reads one or more input datasets and writes one
output dataset. A step runs only when a pipeline references it with `.then(...)`.

## Define a pipeline

This example filters active campaigns, then trims their names. Open each step to see its inputs,
output, and SQL transform. The pipeline runs when the raw dataset changes.

<div data-code-explorer="pipeline"></div>

`.when(...)` accepts a named [schedule](../schedules/overview.md); `.then(...)` appends a step.

## Step builder

`definePipelineStep(id)` chains in a fixed order: `.inputs(...)`, then `.output(...)`, then a
terminal `.sql(...)` or `.run(...)`. Input keys become the names you read inside the executor.

| Method | Purpose |
| --- | --- |
| `.inputs(record)` | Named input datasets, e.g. `{ campaigns: rawCampaigns }`. At least one required. |
| `.output(dataset, options?)` | Output dataset and optional write mode. |
| `.sql(fn)` | SQL transform. `fn` receives each input as an interpolatable ref. |
| `.run(handler)` | TypeScript transform. `handler` receives a run context. |

### Write mode

```ts
.output(cleanCampaigns, { mode: "append" })
```

| `mode` | Behavior |
| --- | --- |
| `"snapshot"` (default) | Writes a full replacement version. |
| `"append"` | Appends rows to the output dataset. |

## SQL steps

Use `.sql(...)` to filter, rename, join, or aggregate rows, as in the example above.
Input names interpolate as table references. SQL uses the DuckDB dialect and requires
[a lake provider with SQL transform support](../infrastructure/overview.md).

## TypeScript steps

Use `.run(...)` for transforms that need application logic or library calls:

```ts
import { definePipelineStep } from "@sixb/core"
import { activeCampaigns, cleanCampaigns } from "../../datasets/campaigns"

export const cleanNames = definePipelineStep("clean-campaign-names")
  .inputs({ campaigns: activeCampaigns })
  .output(cleanCampaigns)
  .run(async ({ inputs, output }) => {
    async function* rows() {
      for await (const row of inputs.campaigns.readRows()) {
        yield { ...row, name: String(row.name).trim() }
      }
    }

    await output.writeRows(rows())
  })
```

| Run context | Purpose |
| --- | --- |
| `inputs[name]` | Dataset, pinned version, and `readRows(options?)` for each named input. |
| `output.writeRows(rows)` | Write a sync or async iterable of rows. |
| `projectId`, `pipelineId`, `stepId`, `runId` | Identify the current run. |
| `signal` | Cooperative cancellation. |

Steps run in `.then(...)` order. Each commits before the next starts, so later steps can read
its output. If a later step fails, earlier committed versions remain available.

## File location

Export definitions from `pipelines/`. See [Project structure](../fundamentals/project-structure.md) for discovery rules.

## Concurrent runs

If another run changes a step's output before it commits, the step fails. Start a new run to recompute; there is no automatic retry.

New input versions create an output version and update event even when rows are unchanged, protecting against older runs. Identical inputs and rows remain a no-op.

## Next

- [Projections](../projections/overview.md) — map pipeline output rows onto ontology objects
- [Datasets](../datasets/overview.md) — define the input and output tables
- [Syncs](../syncs/overview.md) — get raw source rows into Sixb
