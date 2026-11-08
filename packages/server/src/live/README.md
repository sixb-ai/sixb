# Live artifacts

`/ws/artifacts` lets several people edit a canvas at once. Every connected client holds the
artifact's open version as a Yjs document (`@sixb/core/artifacts/live`). Each server holding the
artifact keeps one copy, and writes it back into storage as an ordinary artifact write.

| File | Role |
| --- | --- |
| `routes/ws/artifacts.ts` | The socket: auth as `/ws/agents`, message parsing, one `LiveRooms` per server |
| `rooms.ts` | Which artifacts this server holds, joins and leaves, who each connection is, the `artifact.updated` feed |
| `room.ts` | One artifact: its document, its members, write-back, the live stream, presence |
| `awareness.ts` | What a connection may say of itself in awareness |

## One history

Yjs merges only documents that share a history. Two documents built separately from the same
files each own their `canvas.json`, and syncing them keeps one by client id. So storage keeps the
document itself: `ArtifactRecord.document`, the whole encoded state in a blob and the revision
whose content it holds, replaced with every content write (see
`packages/core/src/artifacts/live/state.ts`).

- Every server loads a room from that state, and every client's document comes from a room. Any
  copy, on any server and after any reload, continues the same history.
- Every write to a canvas is made into that document, whoever makes it
  (`packages/core/src/artifacts/publish/merge.ts`):
  - A live write-back carries the room's state, which is applied to the stored one.
  - A write of files (the Agent, HTTP) is applied as the change from the files it was made from.
  - A restore, or a retried turn's undo, is applied as the change back to the restored files.
- A document whose revision is not the artifact's was left behind by a write that stored none: a
  server from before documents were kept, during a rolling deploy, or a repair by hand. Whoever
  loads it, a room or a write, brings it up to the content as the change from the files it holds.
  An artifact that keeps none yet is built from its files.
- Both are made under a client id derived from what they are made from, so every server makes the
  same document, and the next write stores it again.

## Joining

- On `join`, the server reads the person's access to the artifact. `owner` and `update` edit,
  `read` watches, and anything else is refused with `left`.
- The first join opens the room from the stored document. Other kinds are refused as `not_live`.
- `joined` says who the connection is (`user`: id, name and color, read once per connection).
- A socket message is at most 64 KiB. A larger sync message is sent in parts (`more: true`, see
  `liveSync`), each its own base64, and assembled per connection and artifact up to
  `MAX_LIVE_SYNC_BYTES`.
- A watcher may send sync step 1 (to receive the document) and awareness, never an update. An
  editor's access is read again at most every `ACCESS_RECHECK_MS` while it writes. Losing `update`
  demotes it to a watcher (`access`), and losing `read` removes it (`left`).

## Presence

The server vouches for every awareness state it shares:

- A connection may speak for awareness clients that nobody else speaks for, up to
  `MAX_AWARENESS_CLIENTS`. It may not speak for another connection's client, another server's, or
  the room's own.
- Each state it sets is stored with `user` replaced by who the server knows the person to be, and
  without `sixbAgent`.
- `sixbAgent` is only the server's own state: the boards each Agent turn changed, read from the
  live stream.

## Write-back

- An editor's change marks the room dirty. It is written `SAVE_IDLE_MS` after the last change, at
  most `SAVE_MAX_MS` after the first, and at once when the last editor leaves.
- `flush` publishes through the SDK of the last editor, with the room's state as `document`. The
  write is authored by that person, bumps the revision, and emits `artifact.updated`. If someone
  wrote meanwhile, storage merges both. The room then takes the stored state back under the
  `MERGED` origin, which is never written back again.
- A failure leaves the room dirty, reports `status: failed` with the error, and retries:
  - `artifact_not_found`: the room closes and every member gets `left`.
  - An access error: the author is demoted, and another editor is tried at once.
  - `invalid_artifact`: waits for the next change while someone is connected.
  - Anything else: retries with backoff from 2 s doubling to 30 s. A room nobody holds gives up
    after `RETRIES_UNHELD` attempts, with `console.error`.

## Writes made elsewhere

Every `artifact.updated` for a held artifact queues a `reconcile`, whoever made the write. The
room applies the stored document, brought up to the content if it was left behind, so unsaved
edits stay. An artifact that keeps none at all takes the change from the files the room last took
in. The room's work (flush, reconcile) runs on one queue, one task at a
time.

## Several servers

The broker stream `artifacts.live.<artifactId>` (10 minutes, 5,000 records) carries what reaches
every server at once. Each record is tagged with the server that heard it, so it is not taken back:

- `update`: a Yjs update an editor made. Other servers apply it under the `REMOTE` origin: they show
  it to their members, and leave its write-back to the server that heard it. Applying an update
  twice changes nothing, so a room that opens replays the stream from its start, to get what was
  changed since the last write-back.
- `awareness`: what people point at, as their server vouched for it.
- `agent` / `agent-ended`: the boards an Agent turn changed, appended by `run-artifacts` after each
  canvas write and at the turn's end. Each server drops one after `AGENT_PRESENCE_MS` if the turn
  never ends.

An update the stream no longer holds reaches storage with the write-back of the server that heard
it, so a server that missed it gets it then. A server that dies before writing back loses nothing
its editors still hold: when they reconnect, wherever, their documents sync it again.

## Lifetime

Once the last connection leaves and nothing waits to be written, the room closes and frees its
document. A client that reconnects later gets a room loaded from storage, with the same history, so
plain sync brings back what it changed while away. A connection holds at most
`MAX_LIVE_ARTIFACTS_PER_CONNECTION` artifacts. On server stop, every room writes back first.
