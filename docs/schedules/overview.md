# Schedules

Schedules start syncs, pipelines, and workflows on a timer or in response to an event.
Define and export them from `schedules/`, then attach them to work with `.when(...)`.

## Run on a timer

Use `defineSchedule()` with a five-field cron expression:

```ts
// schedules/invoices.ts
import { defineSchedule } from "@sixb/core"

export const hourlyInvoices = defineSchedule("hourly-invoices").cron("0 * * * *", {
  timezone: "Europe/Paris",
})
```

The fields are `minute hour day-of-month month day-of-week`.

| Expression | Runs |
| --- | --- |
| `*/5 * * * *` | Every five minutes |
| `0 * * * *` | Every hour |
| `0 8 * * 1-5` | Weekdays at 08:00 |
| `0 0 1 * *` | The first day of each month at midnight |

Set an IANA timezone for predictable local times. If omitted, Sixb uses the host machine's
local timezone. Invalid cron expressions and timezones fail at definition time.

## Attach to work

Pass the schedule to a sync, pipeline, or workflow with `.when(...)`:

```ts
// syncs/invoices.ts
import { defineSync } from "@sixb/core"
import { erp } from "../connectors/erp"
import { invoices } from "../datasets/invoices"
import { hourlyInvoices } from "../schedules/invoices"

export const importInvoices = defineSync("import-invoices")
  .when(hourlyInvoices)
  .from(erp)
  .read((client) => client.listInvoices())
  .intoDataset(invoices)
```

A schedule does nothing until attached. IDs must be unique. When a target has multiple schedules,
any one can request a run.

## Run on an event

Use `.on(...)` to select a typed event. Object and link events can also have a `.where(...)`
condition on the event's data:

```ts
// schedules/invoices.ts
import { defineSchedule, events } from "@sixb/core"
import { Invoice } from "../ontology/invoice"

export const highValueInvoice = defineSchedule("high-value-invoice")
  .on(events.object(Invoice).created())
  .where((event) => event.object.p.amount.gt(500))
```

Attach it with `.when(highValueInvoice)`, just like a timer. For workflows that need input,
use `.when(schedule, mapper)` to turn event data into that input. See
[workflow event schedules](../workflows/overview.md#start-a-workflow) for an example.

You can also select link changes, rule signals, action events, dataset updates, and sync or
pipeline outcomes. Conditions are supported on object and link events only.

Event schedules start work when an event occurs. Use [rules](../rules/overview.md) when you need
to track whether a condition is currently active or resolved.

## Next steps

- [Syncs](../syncs/overview.md): Import data on a schedule.
- [Pipelines](../pipelines/overview.md): Transform datasets on a schedule.
- [Workflows](../workflows/overview.md): Coordinate steps and map event data into workflow input.
