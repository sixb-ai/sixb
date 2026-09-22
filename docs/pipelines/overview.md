# Pipelines

A pipeline transforms one or more [datasets](../datasets/overview.md) into another dataset.
Use it to clean, filter, or combine data before mapping it to your domain model.

## Define a pipeline

Define a step with its inputs, output, and transform, then add it to a pipeline with `.then()`.
Export the pipeline from your project's `pipelines/` folder.

This example trims campaign names. `rawCampaigns` and `cleanCampaigns` are datasets defined in
`datasets/campaigns.ts`, each with `id`, `name`, and `status` columns.

File: `pipelines/campaigns.ts`

```ts
import { definePipeline, definePipelineStep } from "@sixb/core"
import { rawCampaigns, cleanCampaigns } from "../datasets/campaigns"

const cleanNames = definePipelineStep("clean-campaign-names")
  .inputs({ campaigns: rawCampaigns })
  .output(cleanCampaigns)
  .sql(({ campaigns }) => `
    select id, trim(name) as name, status
    from ${campaigns}
  `)

export const prepareCampaigns = definePipeline("prepare-campaigns")
  .then(cleanNames)
```

Input names become table references in the SQL query. SQL uses the DuckDB dialect and requires
[a lake provider with SQL transform support](../infrastructure/overview.md).

Each step replaces its output dataset by default. To append rows instead, use
`.output(cleanCampaigns, { mode: "append" })`.

Add more steps with `.then(nextStep)`. They run in order, so each can read the previous step's
output. If a step fails, outputs from earlier steps remain available.

## Run automatically

Create a [schedule](../schedules/overview.md) to run the pipeline when its source dataset changes.

File: `schedules/campaigns.ts`

```ts
import { defineSchedule, events } from "@sixb/core"
import { rawCampaigns } from "../datasets/campaigns"

export const campaignsUpdated = defineSchedule("campaigns-updated")
  .on(events.dataset(rawCampaigns).updated())
```

Import the schedule and attach it to the pipeline with `.when()`:

```ts
// pipelines/campaigns.ts
import { campaignsUpdated } from "../schedules/campaigns"

export const prepareCampaigns = definePipeline("prepare-campaigns")
  .when(campaignsUpdated)
  .then(cleanNames)
```

## TypeScript steps

Use `.run()` instead of `.sql()` when a transform needs your own code or a library.
Here is the same step written in TypeScript:

```ts
import { definePipelineStep } from "@sixb/core"
import { rawCampaigns, cleanCampaigns } from "../datasets/campaigns"

const cleanNames = definePipelineStep("clean-campaign-names")
  .inputs({ campaigns: rawCampaigns })
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

## Next steps

- [Projections](../projections/overview.md): Map the output to your domain model.
- [Schedules](../schedules/overview.md): Run pipelines on a timer or other events.
