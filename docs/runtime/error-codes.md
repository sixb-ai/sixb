# Error codes

Every failure Sixb raises on purpose carries a `SixbErrorCode` — a short, stable string like
`storage.conflict`. The code is written into the run row, returned on the wire, handed to
[`onError`](error-handling.md), and rendered by Atlas. It is the same string on all four surfaces,
so a branch you write once keeps working wherever the failure turns up.

Message text is not part of the contract. It is written for a human reading one failure and may be
reworded in a patch release. Never parse it.

## Catching

```ts
import { isSixbError } from "@sixb/core"

try {
  await sixb.objects(Invoice).upsert(invoice)
} catch (error) {
  if (isSixbError(error, "storage.conflict")) return retryAfterReread()
  if (isSixbError(error, "ontology.invalid_value")) return showFieldErrors(error.details)
  throw error
}
```

`isSixbError` is structural: it recognizes a Sixb failure that crossed a bundle boundary — a custom
app and the client are bundled separately from the runtime — where `instanceof` would not.

For the coarser question — *is this a conflict?* — ask for the kind instead of listing its codes:

```ts
import { sixbErrorKind } from "@sixb/core"

if (sixbErrorKind(error) === "conflict") return retryAfterReread()
```

| Kind | Means | Codes |
| --- | --- | --- |
| `validation` | the input is wrong and nothing was written | `ontology.invalid_value`, `ontology.type_not_found`, `runtime.invalid_definition`, `runtime.invalid_input`, `runtime.payload_too_large`, `storage.edit_rejected`, `storage.query_invalid` |
| `authorization` | the caller may not do this, or is not who they claim to be | `auth.authentication_required`, `auth.invalid_credentials`, `auth.origin_rejected`, `auth.permission_denied`, `auth.session_expired` |
| `conflict` | the state moved underneath the caller | `agent.run_conflict`, `agent.thread_conflict`, `pipeline.already_running`, `queue.lease_lost`, `storage.conflict`, `storage.upload_conflict`, `sync.already_running`, `workflow.run_conflict` |
| `timeout` | a bound was exceeded and the work was abandoned | `action.timed_out`, `agent.timed_out`, `sandbox.timed_out` |
| `provider` | something Sixb does not own failed | `broker.unavailable`, `connector.rate_limited`, `connector.request_failed`, `connector.unauthorized`, `connector.unavailable`, `provider.failed`, `provider.unavailable`, `queue.unavailable`, `storage.blob_failed`, `storage.lake_failed`, `storage.unavailable` |

A code may belong to no kind — `sixbErrorKind` then answers `undefined`. It never belongs to two.

`SixbError` is what the framework throws, whatever failed: the code says which condition it was, and
`details` carries the context. There is no subclass to import and nothing that stops working when a
failure crosses a bundle boundary.

Two failures carry more than a code, and only because a flat `details` cannot hold what they carry:
an invalid or unsupported object query answers with a full `issues` list, and a connector failure
carries the third-party HTTP response it got. Both are still `SixbError`s with a code — branch on the
code, and reach for `objectQueryIssues(error)` when you want the list.

## Retryable

`retryable` answers one question: can running the same operation again, unchanged, plausibly
succeed? It is a property of the condition, so it travels with the code — `SIXB_ERROR_RETRYABLE`
maps every code to its answer — rather than being re-decided at each `throw`. A call site with
better information overrides it on the instance:

```ts
throw new SixbError("provider.failed", message, { retryable: true })
```

The verdict lives on the thrown error, where a `catch` can act on it, and stops there: it is not
part of the recorded failure below. A stored copy would be the same lookup frozen at the moment it
was written, and reading it later would say what the runtime believed then rather than what it
believes now.

It is a hint for the caller, not a promise from the runtime. Which failures Sixb itself retries,
and how many times, is a property of each worker.

## The failure record

A code that is only ever thrown does not help the person looking at a run that failed an hour ago.
So every failure Sixb records — in the `error` column of a run row, in the run the API hands back,
in the failure handed to [`onError`](error-handling.md) — is the same four-field object:

```ts
interface SixbFailure {
  code: SixbErrorCode // "storage.unavailable"
  message: string // "could not reach the object store"
  details?: Record<string, string | number | boolean>
  cause?: string // "ECONNREFUSED"
}
```

`details` is flat and scalar on purpose: it is shown as key/value beside the message and searched
as text, and nothing branches into it. `cause` is what the failure wrapped, outermost first, joined
with `: ` — it names the call that actually refused, which is the part a code is too coarse to say.

Nothing else is in there. No timestamp, because the row, the response, and the log line each carry
their own; no `retryable`, for the reason above. A primitive may add one typed field it genuinely
owns — an action run failure carries the `phase` it died in — and may never re-specify a field the
record already has.

`toSixbFailure(error)` builds one out of anything that was thrown, and never throws doing it.

## On the wire

A request that fails answers with the code and the message, under the key the API has always used:

```json
{ "error": "No sync is registered under 'crm-nightly'", "code": "sync.not_found" }
```

`code` is always there. Branch on it and never on the status, which is coarser: two conditions
answer 409 and only the code says which. The status is a function of the code — one condition
cannot answer 404 on one route and 400 on another — so there is nothing to reconcile between them.

The four-field record is what you get when the failure is part of something the API *returns*
rather than the reason it could not: the `error` of a failed sync run, pipeline step, workflow node,
or action run is the record itself, `details` and `cause` included.

The WebSocket streams carry the pair too. `@sixb/client`'s event, log, and agent-run sockets hand
`onError` a `SixbFailure` and keep the last one on the socket state, so a browser branches on `code`
the way a server-side `catch` does. A failure below the protocol — the socket never opened, the
handshake timed out — has no server code and is filed under `runtime.unexpected`; `connected` and
`reconnecting` are what separate that from a server that answered with a complaint.

## The codes

### `action.*`

| Code | Retryable | Raised when |
| --- | --- | --- |
| `action.commit_failed` | no | The handler succeeded and its edits could not be committed. |
| `action.failed` | no | The action handler threw. |
| `action.not_found` | no | No action is registered under that id. |
| `action.run_not_found` | no | No action run exists under that id. |
| `action.timed_out` | yes | The action exceeded its timeout and was killed. |

### `agent.*`

| Code | Retryable | Raised when |
| --- | --- | --- |
| `agent.execution_lost` | yes | The worker holding the run stopped reporting and the run was reclaimed. |
| `agent.failed` | no | The agent turn threw. |
| `agent.not_found` | no | No agent is registered under that id. |
| `agent.run_conflict` | no | The thread already has a run in flight. |
| `agent.run_not_found` | no | No run exists under that id. |
| `agent.thread_conflict` | no | A thread already exists under that id. |
| `agent.thread_not_found` | no | No thread exists under that id. |
| `agent.timed_out` | yes | The agent turn exceeded its bound. |

### `auth.*`

| Code | Retryable | Raised when |
| --- | --- | --- |
| `auth.authentication_required` | no | The request carried no usable credential. |
| `auth.csrf_rejected` | no | A cookie-authenticated write arrived without a matching CSRF token. |
| `auth.invalid_credentials` | no | A credential was presented and rejected. |
| `auth.origin_rejected` | no | The browser origin is not allowed to call this API. |
| `auth.permission_denied` | no | The principal is authenticated but lacks the grant. |
| `auth.rate_limited` | yes | Too many authentication attempts from this caller. |
| `auth.record_not_found` | no | An auth record — an invitation, an access token, a service account, a session — does not exist. |
| `auth.session_expired` | no | The session was valid and no longer is. |

### `broker.*`

| Code | Retryable | Raised when |
| --- | --- | --- |
| `broker.cursor_expired` | no | Retention removed the position a consumer asked to resume from. |
| `broker.unavailable` | yes | The event broker could not be reached. |

### `connector.*`

| Code | Retryable | Raised when |
| --- | --- | --- |
| `connector.not_found` | no | No connector is registered under that id. |
| `connector.rate_limited` | yes | The upstream API asked the caller to slow down. |
| `connector.request_failed` | no | The upstream API rejected the request. |
| `connector.unauthorized` | no | The connector's credential is missing, expired, or refused. |
| `connector.unavailable` | yes | The upstream API was unreachable or failed on its side. |

### `dataset.*`

| Code | Retryable | Raised when |
| --- | --- | --- |
| `dataset.not_found` | no | No dataset is registered under that id. |
| `dataset.version_not_found` | no | No version of that dataset exists under that id. |

### `event.*`

| Code | Retryable | Raised when |
| --- | --- | --- |
| `event.append_failed` | yes | An event could not be appended to the log. |
| `event.delivery_failed` | yes | A durable delivery attempt failed. |

### `ontology.*`

| Code | Retryable | Raised when |
| --- | --- | --- |
| `ontology.invalid_value` | no | A value failed the schema of the property it was written to. |
| `ontology.type_not_found` | no | The referenced object type or value type is not registered. |

### `pipeline.*`

| Code | Retryable | Raised when |
| --- | --- | --- |
| `pipeline.already_running` | no | A run is already in flight for that pipeline. |
| `pipeline.failed` | no | The pipeline run failed. |
| `pipeline.not_found` | no | No pipeline is registered under that id. |
| `pipeline.run_not_found` | no | No pipeline run exists under that id. |

### `projection.*`

| Code | Retryable | Raised when |
| --- | --- | --- |
| `projection.failed` | no | The projection run failed. |
| `projection.job_stale` | no | The queued job no longer matches durable state: its run is already terminal, its projection or dataset is gone, or its pinned identity has moved. Redelivering it cannot fix it. |
| `projection.not_found` | no | No projection is registered under that id. |
| `projection.run_not_found` | no | No projection run exists under that id. |
| `projection.schema_mismatch` | no | A projection references a column its dataset version does not have, or has under another type. Redelivering the job cannot fix it. |

### `provider.*`

A storage, queue, broker, or sandbox provider Sixb does not ship reports under this namespace and
names itself in `details.provider`. See [Third-party providers](#third-party-providers).

| Code | Retryable | Raised when |
| --- | --- | --- |
| `provider.failed` | no | A provider operation failed. |
| `provider.unavailable` | yes | A provider could not be reached. |

### `queue.*`

| Code | Retryable | Raised when |
| --- | --- | --- |
| `queue.lease_lost` | yes | The delivery lease expired before the job finished; the job returns to the queue. |
| `queue.unavailable` | yes | The queue could not be reached. |

### `rule.*`

| Code | Retryable | Raised when |
| --- | --- | --- |
| `rule.evaluation_failed` | no | A rule threw while evaluating an event. |
| `rule.not_found` | no | No rule is registered under that id. |

### `runtime.*`

| Code | Retryable | Raised when |
| --- | --- | --- |
| `runtime.cancelled` | no | The work was cancelled — shutdown, an abort signal, an explicit stop. |
| `runtime.invalid_definition` | no | A `define*()` call or a `createSixb` option is invalid. Raised at boot. |
| `runtime.invalid_input` | no | A caller-supplied value failed a framework contract. |
| `runtime.invariant_violated` | no | Sixb broke one of its own assumptions. This one is a bug in Sixb. |
| `runtime.not_configured` | no | A required provider slot is empty. |
| `runtime.payload_too_large` | no | The request body exceeded the configured limit. |
| `runtime.unexpected` | no | An error reached a Sixb boundary without a code. |
| `runtime.unsupported` | no | The configured provider does not implement this capability. |

`runtime.unexpected` is the honest default, not a bug in itself: Sixb still raises plain errors in
places, and filing them under one visible code is better than inventing a specific one that would
be wrong. A failure you see often under this code is worth a real code — open an issue.

### `sandbox.*`

| Code | Retryable | Raised when |
| --- | --- | --- |
| `sandbox.failed` | no | The sandbox, or the command inside it, failed. |
| `sandbox.isolation_unavailable` | no | The requested isolation backend is not available on this host. |
| `sandbox.not_running` | no | The sandbox was stopped or destroyed before the call. |
| `sandbox.timed_out` | yes | The command exceeded its timeout and was killed. |

### `storage.*`

| Code | Retryable | Raised when |
| --- | --- | --- |
| `storage.blob_failed` | yes | A blob-storage operation failed. |
| `storage.conflict` | yes | A concurrent write won the race. Re-read, then retry. |
| `storage.edit_rejected` | no | An edit batch violated a constraint and none of it was applied. |
| `storage.file_not_found` | no | The record exists and holds no file at the requested path, or its blob is gone. |
| `storage.lake_failed` | yes | A lake-storage operation failed. |
| `storage.object_not_found` | no | No object exists under that type and primary id. |
| `storage.query_failed` | no | The query was valid and planned, and the store failed to run it. |
| `storage.query_invalid` | no | The query is malformed; the response says which parts. |
| `storage.query_unsupported` | no | The query is valid, and this provider cannot express it. |
| `storage.transaction_failed` | no | A transaction was used incorrectly — nested, or after it closed. |
| `storage.unavailable` | yes | The object store could not be reached. |
| `storage.upload_conflict` | no | The upload session was already completed or aborted. |
| `storage.upload_expired` | no | The upload session's window closed before the content arrived. |
| `storage.upload_invalid` | no | The content does not match what the session was opened for — size, digest, or strategy. |
| `storage.upload_not_found` | no | No upload session exists under that id. |

### `sync.*`

| Code | Retryable | Raised when |
| --- | --- | --- |
| `sync.already_running` | no | A run is already in flight for that sync. |
| `sync.failed` | no | The sync run failed. |
| `sync.not_found` | no | No sync is registered under that id. |
| `sync.run_not_found` | no | No sync run exists under that id. |

### `telemetry.*`

| Code | Retryable | Raised when |
| --- | --- | --- |
| `telemetry.point_not_found` | no | The object has no telemetry point for that property. |

### `webhook.*`

| Code | Retryable | Raised when |
| --- | --- | --- |
| `webhook.failed` | no | The webhook run failed. |
| `webhook.not_found` | no | No webhook is registered under that path. |
| `webhook.run_not_found` | no | No webhook run exists under that id. |
| `webhook.unverified` | no | The payload's signature did not verify. |

### `workflow.*`

| Code | Retryable | Raised when |
| --- | --- | --- |
| `workflow.agent_execution_not_found` | no | No agent execution exists for that run and node. |
| `workflow.failed` | no | The workflow run failed. |
| `workflow.intervention_not_found` | no | No intervention exists under that id. |
| `workflow.intervention_required` | no | The workflow is waiting on a human decision. |
| `workflow.node_run_not_found` | no | No node run exists under that id. |
| `workflow.not_found` | no | No workflow is registered under that id. |
| `workflow.run_conflict` | no | The run's state refuses the request — it is already finished, or not waiting. |
| `workflow.run_not_found` | no | No workflow run exists under that id. |

## Third-party providers

The list above is closed, and the HTTP schema is closed with it: the OpenAPI document declares an
enum, the generated client autocompletes it, and Atlas switches over it exhaustively. An open union
would cost all three.

So a provider Sixb does not ship never mints a code. A storage, queue, broker, sandbox, or blob
provider reports `provider.failed` or `provider.unavailable`; a connector reports `connector.*`.
Both name themselves in `details`:

```ts
import { SixbError } from "@sixb/core/errors"

throw new SixbError("provider.unavailable", "Redis connection refused", {
  details: { provider: "@sixb/queue-bullmq", host },
  cause: error,
})
```

That keeps the enum bounded without making third-party failures anonymous: `details` reaches the
run row, the wire, and Atlas unchanged, so the provider that failed is named wherever the failure
is read.

## Versioning

Adding a code is a minor version bump. A closed enum means an older Atlas or an older generated
client can meet a code it does not know: it renders the raw string rather than a friendly label,
which is a visibly worse message, not a broken response.

Removing or renaming a code is a breaking change and will not happen inside a major version.
