# WebSockets

The Sixb API streams domain changes, run logs, and agent output over WebSockets. Use the [Client SDK](../client/events.md) for typed subscriptions in your app, or the protocol below when building another client.

## Connect

Connect to the API origin using `wss://` in production. Connections use an authenticated browser session and an allowed browser origin. Bearer tokens and shared-access sessions cannot authenticate WebSockets.

| Endpoint | Streams | Access |
| --- | --- | --- |
| `/ws/events` | Domain events. | Events are filtered by the caller's resource permissions. |
| `/ws/logs` | Handler logs. | Requires `can.observe("logs")`. |
| `/ws/agents` | Agent run output and activity. | Requires access to the agent and requested run. |

After receiving `connected`, send a subscription message. The server acknowledges it with `subscribed`. Send `unsubscribe` or close the socket when finished. Errors arrive as a message with `type: "error"` and a `message` string.

Session identity is established when connecting. WebSocket traffic does not renew the browser session; reconnect after signing in again or changing accounts.

## Domain events

Subscribe to a topic, event types, or a specific object:

```json
{
  "type": "subscribe",
  "topic": "objects",
  "types": ["object.created", "object.updated"],
  "objectTypeId": "Invoice",
  "limit": 100
}
```

Other optional filters are `primaryId`, `actionId`, and `runId`. `limit` is the read batch size, up to 500, rather than a total event limit.

Each event arrives in an `event` frame:

```json
{
  "type": "event",
  "event": {
    "id": "event-1",
    "type": "object.updated",
    "topic": "objects",
    "cursor": "opaque-cursor",
    "occurredAt": "2026-09-22T12:00:00.000Z"
  }
}
```

This abbreviated example shows common fields. The event also carries its subject, payload, and project context. The `SixbEvent` type from `@sixb/client` describes the complete event union.

| Topic | Example events |
| --- | --- |
| `objects` | `object.created`, `object.updated`, `object.deleted` |
| `links` | `link.created`, `link.updated`, `link.deleted` |
| `telemetry` | `telemetry.appended` |
| `actions` | `action.requested`, `action.completed`, `action.failed` |
| `workflows` | `workflow.run.started`, `workflow.run.finished` |
| `rules` | `rule.triggered`, `rule.resolved` |
| `schedules` | `schedule.triggered` |
| `datasets` | `dataset.version.committed` |
| `syncs`, `pipelines` | Run lifecycle events. |

Visibility follows the subject's permissions. For example, invoice events require view access to invoices, and link events require view access to both endpoint types. There is no separate grant to read all domain events.

## Replay events

Without a cursor, a new event connection starts with live changes. To resume, send the last received cursor as `afterCursor` in the subscription:

```json
{
  "type": "subscribe",
  "topic": "objects",
  "afterCursor": "last-received-cursor"
}
```

Treat cursors as opaque. Events have bounded retention, so reconnecting clients may need to refetch current state when a cursor expires. Tolerate repeated events by their ID. For paginated history over HTTP, use `GET /api/events` in your API's `/docs` reference.

## Run logs

Subscribe to a run, kinds, or exact levels. Omit filters to receive all logs you can observe:

```json
{
  "type": "subscribe",
  "run": { "kind": "action", "id": "run-1" },
  "levels": ["warn", "error"]
}
```

Logs arrive in `logs` frames containing a `logs` array. Each line includes its message, level, fields, run context, and cursor. Supply `afterCursor` to resume after a previous log. Without it, the subscription starts with new lines.

If the cursor has expired, the server sends a `reset` frame with reason `cursor_expired`. Refetch retained logs before continuing with live output.

Use [Logging](../logging/overview.md) to configure capture or the [logs builder](../client/overview.md#read-run-logs) to read retained lines.

## Agent runs

Subscribe to one run:

```json
{
  "type": "subscribe",
  "runId": "run-1"
}
```

The server sends retained output followed by live `record` frames, plus a `run.snapshot` frame with the current run. Supply `afterCursor` to resume. If retained output no longer covers that cursor, the server resumes from the earliest available output and acknowledges a null cursor.

Send `replay` with a run ID, optional cursor, and `limit` to read a bounded page. `subscribe.activity` selects project agent activity instead of an individual run. A socket has one active subscription.

React apps can use `useAgentRunStream` from `@sixb/client/hooks` instead of handling these messages directly.
