# Live artifacts

`/ws/artifacts` lets several people edit a canvas at once. Every connected client holds the
artifact's open version as a Yjs document (`@sixb/core/artifacts/live`). The server holds one copy
per artifact and writes it back into storage as an ordinary artifact write.

| File | Role |
| --- | --- |
| `routes/ws/artifacts.ts` | The socket: auth as `/ws/agents`, message parsing, one `LiveRooms` per server |
| `rooms.ts` | Which artifacts this server holds, joins and leaves, and the `artifact.updated` feed |
| `room.ts` | One artifact: its document, its members, write-back, merges, presence |

## Joining

- On `join`, the server reads the person's access to the artifact. `owner` and `update` edit,
  `read` watches, and anything else is refused with `left`.
- The first join opens the room. It loads the latest version's files, holding text files as
  `Y.Text` and `canvas.json` as items plus order. Other kinds are refused as `not_live`.
- `joined` names the room's copy (`document`). Yjs merges only documents that share a history: two
  copies loaded separately from the same files each own their `canvas.json`, so syncing them picks
  one by client id. A client whose document came from another copy starts from an empty document.
  Once in step, it applies what it changed meanwhile with `mergeIntoDocument`.
- A socket message is at most 64 KiB. A larger sync message is sent in parts (`more: true`, see
  `liveSync`), each its own base64, and assembled per connection and artifact up to
  `MAX_LIVE_SYNC_BYTES`.
- A watcher may send sync step 1 (to receive the document) and awareness, never an update. An
  editor's access is read again at most every `ACCESS_RECHECK_MS` while it writes. Losing `update`
  demotes it to a watcher (`access`), and losing `read` removes it (`left`).

## Write-back

- An editor's change marks the room dirty. It is written `SAVE_IDLE_MS` after the last change, at
  most `SAVE_MAX_MS` after the first, and at once when the last editor leaves.
- `flush` stores the changed texts (unchanged ones keep their blob reference) and publishes through
  the SDK of the last editor. The write is authored by that person, bumps the revision, and emits
  `artifact.updated`. It carries `baseRevision` and `baseFiles`, so a canvas written meanwhile is
  merged rather than refused. When it was merged, the result is merged back into the document under
  the `MERGED` origin, which is never written back again.
- A failure leaves the room dirty, reports `status: failed` with the error, and retries:
  - `artifact_not_found`: the room closes and every member gets `left`.
  - An access error: the author is demoted, and another editor is tried at once.
  - `invalid_artifact`: waits for the next change while someone is connected.
  - Anything else: retries with backoff from 2 s doubling to 30 s. A room nobody holds gives up
    after `RETRIES_UNHELD` attempts, with `console.error`.

## Writes made elsewhere

Every `artifact.updated` for a held artifact queues a `reconcile`, whether an Agent turn, an
HTTP write, or another server made it. The room reads the latest version and merges it into the
document as a diff against the files it last matched (`synced`), so unsaved edits stay. The room's
work (flush, reconcile) runs on one queue, one task at a time.

## Several servers

Each server holds its own copy, and copies do not exchange Yjs updates: independently loaded
copies cannot merge (see Joining), and each server would otherwise merge the same storage writes
again. Copies meet in storage. Each one writes back, and every other one merges that write through
`artifact.updated`. Edits therefore reach people on another server one write-back later (about
`SAVE_IDLE_MS`).

The broker stream `artifacts.live.<artifactId>` (short retention) carries what has to be instant
everywhere:

- `awareness`: who is here and what they point at, tagged with the server that heard it, so it is
  not shared back.
- `agent` / `agent-ended`: the boards an Agent turn changed, appended by `run-artifacts` after each
  canvas write and at the turn's end. Each server shows them as its own awareness state under
  `sixbAgent`, and drops one after `AGENT_PRESENCE_MS` if the turn never ends.

## Lifetime

Once the last connection leaves and nothing waits to be written, the room stays open for
`ROOM_LINGER_MS`. A client that reconnects meanwhile finds the same copy and syncs what it changed
while away. Then the room closes and frees its document. A connection holds at most
`MAX_LIVE_ARTIFACTS_PER_CONNECTION` artifacts. On server stop, every room writes back first.
