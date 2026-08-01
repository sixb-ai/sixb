# Events & Webhooks

Sixb has two event surfaces. Reach for **domain events** to read, stream, or audit what
happened inside a project. Reach for **webhooks** to receive deliveries from an external
provider.

- **Domain events** — an append-only log of everything the runtime does (objects changed,
  telemetry appended, runs started and finished, and so on). Access them through `sixb.events`.
- **Webhooks** — inbound HTTP endpoints owned by a [connector](../data/connectors.md) that
  receive provider deliveries and run a handler.

> The event log API is an **observability surface, not a trigger API**. Appending an event does
> not directly run a [rule](../rules/overview.md) or [workflow](../workflows/overview.md).
> Declarative [event schedules](../schedules/events.md) use event selectors, but they are defined and
> registered separately from manual event appends.

## Domain events

Every event shares a common envelope and carries a typed `payload`. The full set comes from
the core event registry.

### Event catalog

| Type | Topic | Payload highlights |
| --- | --- | --- |
| `object.created` | `objects` | `objectTypeId`, `primaryId`, `properties`, `propertyChanges` |
| `object.updated` | `objects` | `objectTypeId`, `primaryId`, `properties`, `propertyChanges` |
| `object.deleted` | `objects` | `objectTypeId`, `primaryId`, `propertyChanges` |
| `telemetry.appended` | `telemetry` | `objectTypeId`, `objectId`, `propertyId`, `value`, `unit?`, `at` |
| `link.created` | `links` | `sourceTypeId`, `sourceId`, `linkId`, `targetTypeId`, `targetId`, `properties?`, `propertyChanges` |
| `link.updated` | `links` | `sourceTypeId`, `sourceId`, `linkId`, `targetTypeId`, `targetId`, `properties?`, `propertyChanges` |
| `link.deleted` | `links` | `sourceTypeId`, `sourceId`, `linkId`, `targetTypeId`, `targetId`, `propertyChanges` |
| `action.requested` | `actions` | `actionId`, `subject`, `params`, `runId` |
| `action.completed` | `actions` | `actionId`, `runId`, `subject`, `finishedAt` |
| `action.failed` | `actions` | `actionId`, `runId`, `subject`, `error`, `finishedAt` |
| `schedule.triggered` | `schedules` | `scheduleId` |
| `rule.triggered` / `rule.resolved` | `rules` | `ruleId`, `subject` |
| `sync.run.started` / `sync.run.finished` | `syncs` | `syncId`, `runId` |
| `pipeline.run.*` (started, step.started, step.finished, finished) | `pipelines` | `pipelineId`, `runId` |
| `workflow.run.*` (queued, started, node.started, waiting, node.waiting, node.finished, finished) | `workflows` | `workflowId`, `runId` |
| `workflow.intervention.*` (requested, submitted, cancelled, expired) | `workflows` | `workflowId`, `runId` |
| `dataset.version.committed` | `datasets` | `datasetId` |

`EVENT_TYPES` and `EVENT_TOPICS` are exported from `@sixb/core` for the canonical lists at
runtime.

### Event envelope

Every stored event is a `StoredDomainEvent`: the `EventEnvelope` fields below, plus the
event's `type`, `topic`, `partitionKey`, `payload`, and a broker `cursor`.

| Field | Type | Notes |
| --- | --- | --- |
| `id` | `string` | Unique event id |
| `schemaVersion` | `1` | Envelope schema version |
| `projectId` | `string` | Owning project |
| `occurredAt` | `string` | ISO timestamp |
| `correlationId` | `string?` | Groups related events |
| `causationId` | `string?` | The event that caused this one |
| `idempotencyKey` | `string?` | De-duplicates appends |
| `actor` | `{ type, id }?` | Who made the write: `user`, `service`, or `system`. Absent when a privileged caller wrote it — a worker, a sync, or startup code |
| `metadata` | `Record<string, JsonValue>?` | Free-form context |
| `origin` | `{ kind, ... }?` | What produced the event: an `action`, a `runtime` write, a `projection`, or a `telemetry` append |
| `commitId` | `string?` | Groups every object, link, and telemetry event that came from the same write |
| `commitOrdinal` | `number?` | Correlates this event's position within that write; it does not guarantee delivery order |
| `cursor` | `string` | Broker position; pass as `afterCursor` to page forward |

Object, link, and telemetry events are recorded as part of the write that changed the data, so a
broker outage delays delivery but never drops them. Their `id` is stable across redelivery, so a
consumer that may see an event twice can de-duplicate on it.

`origin` and `actor` answer different questions, and together they tell you how a change happened:

| `origin.kind` | `actor` | The write was |
| --- | --- | --- |
| `action` | the requester | governed — validated, and recorded as a run |
| `runtime` | the principal | a direct write through `edit:object` or `append:telemetry` |
| `runtime` | absent | system code: a worker, a sync, startup |
| `projection` | absent | derived from a dataset |

By default events are kept as a short recent log (the built-in stream retains the last two
days), not a permanent history. A custom broker stream can change the retention window.

### Reading events

`sixb.events.read(input)` returns stored events oldest-first, optionally filtered by `topics`
and/or `types` and paged with `afterCursor`.

```ts
const recent = await sixb.events.read({
  types: ["object.updated", "telemetry.appended"],
  limit: 100,
})

for (const event of recent) {
  console.log(event.type, event.cursor)
}
```

`sixb.events.latestCursor()` returns the newest retained cursor without loading event payloads.
It is intended for efficient subscription baselines and returns `undefined` when the retained
stream is empty.

| Option | Type | Notes |
| --- | --- | --- |
| `topics` | `readonly Topic[]` | Filter by topic (e.g. `"objects"`) |
| `types` | `readonly Type[]` | Filter by event type |
| `afterCursor` | `string` | Return events after this cursor |
| `limit` | `number` | Max events to return |

### Subscribing to events

`sixb.events.subscribe(input, handler)` streams new events as they are appended and returns
an unsubscribe function. Handler errors are swallowed to preserve fire-and-forget delivery.

```ts
const unsubscribe = await sixb.events.subscribe(
  { types: ["action.completed", "action.failed"] },
  (events) => {
    for (const event of events) {
      console.log("invoice action finished", event.payload)
    }
  }
)

// later
unsubscribe()
```

In browser apps, use the `@sixb/client` event builder and React hooks instead of hand-written
predicates. See [Client events](../client/events.md). For action buttons, prefer
`useActionRunMutation` unless the screen needs broader live coordination.

### Appending events

`sixb.events.append(input)` authors supported non-ontology domain events:

```ts
// fire a scheduled workflow now, without waiting for its cron
await sixb.events.append({
  events: [
    {
      type: "schedule.triggered",
      payload: {
        scheduleId: "nightly-invoice-sweep",
        occurrenceAt: "2026-04-18T02:00:00.000Z",
        triggeredAt: "2026-04-18T02:00:00.000Z",
        occurrenceKey: "nightly-invoice-sweep:2026-04-18T02:00:00.000Z",
      },
    },
  ],
})
```

Ontology facts are not appendable. `object.*`, `link.*`, and `telemetry.*` are not in the parameter
type, so they do not compile, and the runtime throws for a caller that reached it untyped. The
Materializer emits them itself once the ontology commit succeeds — write through the ontology and
the event follows:

```ts
// emits object.updated after the commit
await sixb.objects(Invoice).upsert({
  properties: { id: "INV-1042", status: "paid" },
})
```

Ontology facts use at-least-once broker delivery:

```text
ontology transaction -> durable ontology_outbox -> immediate drain -> 60s recovery catch-up
```

Broker failure delays subscribers but never rolls back or loses the committed ontology change.
Consumers deduplicate with stable event IDs when required. CDC/WAL change streams are not part of
V0.1.0.

An envelope that the broker repeatedly rejects remains durable and retryable; it is never silently
dropped. After repeated failures `/api/status` stays `degraded` until delivery succeeds. V0.1.0 does
not provide automatic quarantine or operator requeue.

### HTTP: GET /api/events

The [server](../server/overview.md) exposes the same log over HTTP. Results are
**authorization-scoped**: a request only sees events the caller is permitted to read (see
[Authorization](../auth/authorization.md)).

```bash
curl "http://localhost:3000/api/events?type=object.updated&limit=50"
```

| Query param | Notes |
| --- | --- |
| `topic` | One topic from `EVENT_TOPICS` |
| `type` | One type from `EVENT_TYPES` |
| `afterCursor` | Page forward from a cursor |
| `limit` | Max events to return |

The response is `{ count, events }`. Events filtered out by scope are simply omitted; a
caller with no permission gets `403`.

## Webhooks

A webhook is an inbound HTTP endpoint defined on a [connector](../data/connectors.md). The
server owns route registration and dispatch; you own verification, parsing, and handling.

Define one with `defineWebhook(id)` and attach it to the connector's `webhooks` array.

```ts
import { defineConnector, defineWebhook } from "@sixb/core"
import { createAcmeErpClient } from "../lib/acme-erp"

const WEBHOOK_SIGNATURE = "acme-local-secret"

export const acmeErpConnector = defineConnector("acme-erp", {
  type: "acme-erp",
  webhooks: [
    defineWebhook("invoice-events")
      .post()
      .json({ parse: parseInvoiceWebhookEvent })
      .verify(({ request }) => {
        if (request.headers.get("x-acme-signature") !== WEBHOOK_SIGNATURE) {
          throw new Error("Invalid Acme webhook signature")
        }
      })
      .idempotencyKey(
        ({ body, request }) => request.headers.get("x-acme-delivery") ?? body.deliveryId
      )
      .handle(({ body }) => {
        console.log(`received ${body.type} for ${body.invoiceId}`)
      }),
  ],
  connect() {
    return createAcmeErpClient()
  },
})
```

Each webhook is registered at `POST /api/webhooks/<connectorId>/<webhookId>`. The builder
steps:

| Step | Purpose |
| --- | --- |
| `.post()` | Method (webhooks are POST-only) |
| `.json(schema?)` / `.text()` / `.raw()` | Body format and parser; `schema.parse(value)` validates and types the body |
| `.verify(ctx)` | Optional; runs on raw bytes before parsing — throw to reject (`401`) |
| `.idempotencyKey(ctx)` | Optional; returns a stable delivery id, or `null`/`undefined` to skip de-duplication |
| `.handle(ctx)` | Required; runs the side effect, may return a `WebhookResponse` |

The handler context carries the parsed `body`, the `request`, connector metadata, and a lazy
`client()` that connects the outbound connector only if the handler needs it.

### Dispatch lifecycle

For each delivery the server runs these steps in order:

1. **Verify** — call `verify` with raw bytes. Failure returns `401`.
2. **Parse** — decode by body format and run the parser. Failure returns `400`.
3. **Claim** — resolve the idempotency key and claim the delivery. A `duplicate` or
   `in_progress` claim short-circuits to `202 Accepted` without re-running the handler.
4. **Handle** — run `handle`. A throw marks the delivery failed (so the provider's next retry
   can re-attempt) and returns `500`.
5. **Complete** — mark the delivery complete only after the handler succeeds.

When the handler returns nothing, dispatch responds `202 Accepted`; otherwise it applies the
returned `status`, `headers`, and `body`. Every delivery is recorded as a webhook run for
observability (visible in the UI under the connector). Claiming and completion require
webhook delivery storage to be configured.

## Related

- [Connectors](../data/connectors.md) — where webhooks live
- [Client events](../client/events.md) — event builders and React hooks for apps
- [Event schedules](../schedules/events.md) — start work from typed events
- [Rules](../rules/overview.md) and [Workflows](../workflows/overview.md) — declarative state
  and multi-step processes
- [Running actions from apps](../apps/actions.md) — action button state and scoped action events
- [Server](../server/overview.md) — the HTTP/WebSocket API
- [Authorization](../auth/authorization.md) — how `/api/events` is scoped
