# Error codes

Every failure Sixb raises on purpose carries a `SixbErrorCode` — a short, stable string like
`storage.conflict`. The code is written into the run row, returned on the wire, handed to the
runtime observer, and rendered by Atlas. It is the same string on all four surfaces, so a branch
you write once keeps working wherever the failure turns up.

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

For the coarser question, catch a class instead. Each one owns a closed set of codes:

| Class | Means | Codes |
| --- | --- | --- |
| `SixbValidationError` | the input is wrong and nothing was written | `ontology.invalid_value`, `ontology.type_not_found`, `runtime.invalid_definition`, `runtime.invalid_input`, `runtime.payload_too_large`, `storage.edit_rejected`, `storage.query_invalid` |
| `SixbAuthorizationError` | the caller may not do this, or is not who they claim to be | `auth.authentication_required`, `auth.invalid_credentials`, `auth.origin_rejected`, `auth.permission_denied`, `auth.session_expired` |
| `SixbConflictError` | the state moved underneath the caller | `agent.run_conflict`, `pipeline.already_running`, `queue.lease_lost`, `storage.conflict`, `sync.already_running` |
| `SixbTimeoutError` | a bound was exceeded and the work was abandoned | `action.timed_out`, `agent.timed_out`, `sandbox.timed_out` |
| `SixbProviderError` | something Sixb does not own failed | `broker.unavailable`, `connector.rate_limited`, `connector.request_failed`, `connector.unauthorized`, `connector.unavailable`, `provider.failed`, `provider.unavailable`, `queue.unavailable`, `storage.blob_failed`, `storage.lake_failed`, `storage.unavailable` |

A code may belong to no class. It never belongs to two.

## Retryable

`retryable` answers one question: can running the same operation again, unchanged, plausibly
succeed? It is a property of the condition, so it travels with the code — `SIXB_ERROR_RETRYABLE`
maps every code to its answer — rather than being re-decided at each `throw`. A call site with
better information overrides it on the instance:

```ts
throw new SixbProviderError("provider.failed", message, { retryable: true })
```

The verdict lives on the thrown error, where a `catch` can act on it, and stops there: it is not
part of the recorded failure below. A stored copy would be the same lookup frozen at the moment it
was written, and reading it later would say what the runtime believed then rather than what it
believes now.

It is a hint for the caller, not a promise from the runtime. Which failures Sixb itself retries,
and how many times, is a property of each worker.

## The failure record

A code that is only ever thrown does not help the person looking at a run that failed an hour ago.
So every failure Sixb records — in the `error` column of a run row, in an HTTP error response, in
the event handed to the runtime observer — is the same four-field object:

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

## The codes

### `action.*`

| Code | Retryable | Raised when |
| --- | --- | --- |
| `action.commit_failed` | no | The handler succeeded and its edits could not be committed. |
| `action.failed` | no | The action handler threw. |
| `action.not_found` | no | No action is registered under that id. |
| `action.timed_out` | yes | The action exceeded its timeout and was killed. |

### `agent.*`

| Code | Retryable | Raised when |
| --- | --- | --- |
| `agent.execution_lost` | yes | The worker holding the run stopped reporting and the run was reclaimed. |
| `agent.failed` | no | The agent turn threw. |
| `agent.not_found` | no | No agent is registered under that id. |
| `agent.run_conflict` | no | The thread already has a run in flight. |
| `agent.run_not_found` | no | No run exists under that id. |
| `agent.thread_not_found` | no | No thread exists under that id. |
| `agent.timed_out` | yes | The agent turn exceeded its bound. |

### `auth.*`

| Code | Retryable | Raised when |
| --- | --- | --- |
| `auth.authentication_required` | no | The request carried no usable credential. |
| `auth.invalid_credentials` | no | A credential was presented and rejected. |
| `auth.origin_rejected` | no | The browser origin is not allowed to call this API. |
| `auth.permission_denied` | no | The principal is authenticated but lacks the grant. |
| `auth.rate_limited` | yes | Too many authentication attempts from this caller. |
| `auth.record_not_found` | no | An auth record — an invitation, an access token, a service account — does not exist. |
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

### `projection.*`

| Code | Retryable | Raised when |
| --- | --- | --- |
| `projection.failed` | no | The projection run failed. |

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
| `storage.lake_failed` | yes | A lake-storage operation failed. |
| `storage.object_not_found` | no | No object exists under that type and primary id. |
| `storage.query_failed` | no | The query was valid and planned, and the store failed to run it. |
| `storage.query_invalid` | no | The query is malformed; the response says which parts. |
| `storage.query_unsupported` | no | The query is valid, and this provider cannot express it. |
| `storage.transaction_failed` | no | A transaction was used incorrectly — nested, or after it closed. |
| `storage.unavailable` | yes | The object store could not be reached. |
| `storage.upload_invalid` | no | The upload session is unknown, expired, or already finished. |

### `sync.*`

| Code | Retryable | Raised when |
| --- | --- | --- |
| `sync.already_running` | no | A run is already in flight for that sync. |
| `sync.failed` | no | The sync run failed. |
| `sync.not_found` | no | No sync is registered under that id. |

### `webhook.*`

| Code | Retryable | Raised when |
| --- | --- | --- |
| `webhook.failed` | no | The webhook run failed. |
| `webhook.not_found` | no | No webhook is registered under that path. |
| `webhook.unverified` | no | The payload's signature did not verify. |

### `workflow.*`

| Code | Retryable | Raised when |
| --- | --- | --- |
| `workflow.failed` | no | The workflow run failed. |
| `workflow.intervention_required` | no | The workflow is waiting on a human decision. |
| `workflow.not_found` | no | No workflow is registered under that id. |

## Third-party providers

The list above is closed, and the HTTP schema is closed with it: the OpenAPI document declares an
enum, the generated client autocompletes it, and Atlas switches over it exhaustively. An open union
would cost all three.

So a provider Sixb does not ship never mints a code. A storage, queue, broker, sandbox, or blob
provider reports `provider.failed` or `provider.unavailable`; a connector reports `connector.*`.
Both name themselves in `details`:

```ts
import { SixbProviderError } from "@sixb/core/errors"

throw new SixbProviderError("provider.unavailable", "Redis connection refused", {
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
