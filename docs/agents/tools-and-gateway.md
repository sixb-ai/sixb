# Tools and gateway

Every agent run gets two ways to do real work: a built-in `bash` tool that runs in a sandbox, and
scoped access to your project's own objects, actions, and telemetry.

## The bash tool

The `bash` tool runs a command (as `bash -lc`) inside a per-run [sandbox](../sandboxes/overview.md)
that the worker provisions for the turn and destroys when it ends.

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `command` | `string` | — | The command to run. |
| `cwd` | `string` | sandbox default | Working directory. |
| `timeoutMs` | `number` | 30s (max 120s) | Per-command timeout. |

It returns the command result with `stdoutTruncated` / `stderrTruncated` flags; output is capped so a
runaway command can't flood the turn. The sandbox boots concurrently with the turn, so if the model
never calls `bash` the boot cost never lands on the user.

### A sandbox is required

The `bash` tool always runs in a sandbox, so the agent-worker won't start without a factory:

```ts
import { createSixb } from "@sixb/core"
import { SmolvmSandboxFactory } from "@sixb/sandboxes-smolvm"

export const sixb = createSixb({
  id: "acme-corp",
  // ...
  sandboxes: new SmolvmSandboxFactory(),
})
```

See [Sandboxes](../sandboxes/overview.md) for factory options and isolation.

## Reaching your data

Inside the sandbox, the run gets a base URL and credentials in its environment to call a scoped
slice of your HTTP API — typically with `curl` from `bash`. So an agent works against live project
data, not a snapshot. These routes are allowed (everything else returns `403`):

| Area | Routes |
| --- | --- |
| Project | `GET /api/project` |
| Object types | `GET /api/object-types`, `GET /api/object-types/:id` |
| Objects | `GET /api/objects`, `POST /api/objects/query` (+ `/count`, `/exists`, `/facets`), `GET /api/objects/:objectTypeId/:objectId` |
| Telemetry | `POST /api/telemetry/history`, `GET .../telemetry/:propertyId/history`, `.../latest` |
| Actions | `GET /api/actions`, `GET /api/actions/:actionId`, `POST /api/actions/:actionId`, `GET /api/action-runs/:runId` |

Requests run under the agent's [execution identity](./authorization.md), so the agent can only see
and act on what its groups allow — the same checks as any other caller, and only while the run is
active.

## Related

- [Sandboxes](../sandboxes/overview.md)
- [Authorization](./authorization.md)
- [Objects](../objects/overview.md) and [Actions](../actions/overview.md) — what the agent can query and request.
