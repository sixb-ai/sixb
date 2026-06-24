# Schedules

A schedule is a reusable, named trigger. It says *when* work should run, never *what* — you
attach it to a sync, pipeline, or workflow, and that work runs on the schedule.

## Defining a schedule

Build one with `defineSchedule(id)`. The only trigger method is `.cron(...)`, with an optional
timezone. It produces an inert `ScheduleDefinition` that does nothing until something
references it.

File: `schedules/erp.ts`

```ts
import { defineSchedule } from "@sixb/core"

export const hourlyErpSync = defineSchedule("hourly-erp-sync").cron("0 * * * *", {
  timezone: "Europe/Paris",
})
```

| Method | Signature | Notes |
| --- | --- | --- |
| `.cron(expression, options?)` | `expression: string`, `options?: { timezone?: string }` | `timezone` is validated against `Intl.DateTimeFormat`; an invalid zone throws |

## Attaching with `.when(...)`

A schedule drives work only when a sync, pipeline, or workflow references it through
`.when(...)`. Pass the schedule definition itself:

```ts
import { defineSync } from "@sixb/core"
import { acmeErpConnector } from "../connectors/acme-erp"
import { erpDepartmentsDataset } from "../datasets/erp"
import { hourlyErpSync } from "../schedules/erp"

export const syncErpDepartments = defineSync("sync-erp-departments")
  .when(hourlyErpSync)
  .from(acmeErpConnector)
  .read((client) => client.listDepartments())
  .intoDataset(erpDepartmentsDataset)
```

`.when(...)` on [syncs](../data/syncs.md) and [pipelines](../data/pipelines.md) also accepts
run triggers (`syncFinished(id)`, `pipelineFinished(id)`, `datasetUpdated(id)`) to chain runs
off other runs. [Workflows](../workflows/overview.md) accept schedule definitions only.
Multiple triggers on the same target use OR semantics: any one can request a run.

## Cron dialect

sixb uses a 5-field cron expression: `minute hour day-of-month month day-of-week`.

| Field | Range | Notes |
| --- | --- | --- |
| minute | 0–59 | |
| hour | 0–23 | |
| day-of-month | 1–31 | |
| month | 1–12 | |
| day-of-week | 0–6 | 0 = Sunday; `7` is normalized to `0` |

Each field supports `*` (any), lists (`1,15`), ranges (`9-17`), and steps (`*/5`, `0-30/10`).
When *both* day-of-month and day-of-week are restricted (neither is `*`), a tick matches if
*either* one matches (standard cron OR semantics); otherwise both must match.

```txt
0 8 * * *      every day at 08:00
*/5 * * * *    every 5 minutes
0 9-17 * * 1-5 every hour, 09:00–17:00, Mon–Fri
0 0 1 * *      midnight on the 1st of each month
```

### Timezone

Pass an IANA zone to `.cron(...)` (e.g. `"Europe/Paris"`, `"America/New_York"`) when a
schedule must fire relative to a specific wall clock. Without it, schedules are evaluated
against the host machine's local time.

## Discovery

`createSixb()` auto-discovers exported `ScheduleDefinition`s from the `schedules/` folder. A
schedule takes effect only through the sync, pipeline, or workflow that references it with
`.when(...)`.

```txt
my-project/
  schedules/
    erp.ts    # defineSchedule(...).cron(...)
```

See [Project structure](../fundamentals/project-structure.md) for the full folder layout, and
the [examples](../examples/overview.md) for complete projects.
