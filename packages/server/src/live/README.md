# Live artifacts

`/ws/artifacts` lets several people edit a canvas, or a document, Markdown or designed, at once. Every connected
client holds the artifact's open version as a Yjs document (`@sixb/core/artifacts/live`). Each
server holding the artifact keeps one copy, and writes it back into storage as an ordinary artifact
write.

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
- Every write to an artifact that keeps a document is made into it, whoever makes it
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
- The first join opens the room from the stored document. A sheet, a page, a deck or a file is
  refused as `not_live`.
- `joined` says who the connection is (`user`: id, name and color, read once per connection). A
  shared link's guest is read at each join instead, from its session: `guest:<sessionId>`, the
  name they gave, and `guest: true`. Once they give a name, their socket reads it from the session
  (`LiveRooms.refreshUser`): their awareness states take it, and the room shares them again. A name is never an email or an id, since every connection,
  a guest's included, sees the same state: someone who gave none has an empty name.
- A shared link's socket reads its session again every `SHARED_SOCKET_RECHECK_MS`, and on its next
  message past that (`routes/ws/shared-sockets.ts`): its SDK keeps the authority the upgrade
  proved, so revocation is seen only there. One that ended is closed with 4401.
- A socket message is at most 64 KiB. A larger sync message is sent in parts (`more: true`, see
  `liveSync`), each its own base64, and assembled per connection and artifact up to
  `MAX_LIVE_SYNC_BYTES`.
- A watcher may send sync step 1 (to receive the document) and awareness, never an update. An
  editor's access is read again at most every `ACCESS_RECHECK_MS` while it writes, and every
  member's on each write to the artifact and every `MEMBERS_RECHECK_MS`. Losing `update`
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
- `flush` writes the room's state through `writeLiveArtifact`, with the SDK of the last editor:
  the public `update` takes files only, and this server-only entry makes the same write from the
  document. The write is authored by that person, bumps the revision, and emits
  `artifact.updated`. If someone
  wrote meanwhile, storage merges both. The room then takes the stored state back under the
  `MERGED` origin, which is never written back again. The document holds no title: the write
  passes the title it last read as `baseTitle`, so a title given since stays.
- A write-back that changes a board asks for its pictures like any write: in the artifact's one
  preview job, which it replaces, due `BOARD_PREVIEW_JOB.settleMs` later. That is longer than
  `SAVE_MAX_MS`, so a board being typed in is pictured once, after its editors pause.
- A client's change is tried first on a shadow copy of the document. One that leaves it unreadable
  (`documentFiles` throws) is refused with an `error` before anyone gets it, so a poisoned history
  never spreads or wedges the write-back.
- A failure leaves the room dirty, reports `status: failed` with the error, and retries:
  - `artifact_not_found`: the room closes and every member gets `left`.
  - An access error: the author is demoted, and another editor is tried at once.
  - `invalid_artifact`: waits for the next change while someone is connected.
  - Anything else: retries with backoff from 2 s doubling to 30 s, for as long as the server runs,
    whether or not anyone still holds the room.
- Changes are lost only when nobody can write them: the server stops first, or storage refuses
  them (an access error, `invalid_artifact`) once nobody is left who could change that. The room
  then reports `artifact.live_write.failed` to the project's `onError`, through
  `LiveRoomHost.errorReporterHost`, and drops them.

## Writes made elsewhere

Every `artifact.updated` for a held artifact queues a `reconcile`, whoever made the write. The
room applies the stored document, brought up to the content if it was left behind, so unsaved
edits stay. An artifact that keeps none at all takes the change from the files the room last took
in. The room's work (flush, reconcile) runs on one queue, one task at a
time.

## Several servers

Two broker streams carry what reaches every server at once. Each record is tagged with the server
that heard it, so it is not taken back.

`artifacts.live.<artifactId>` (10 minutes, 5,000 records):

- `update`: a Yjs update an editor made. Other servers apply it under the `REMOTE` origin and show
  it to their members. The server that heard it writes it back. Each other server marks it
  unwritten, and writes it back too `HEARD_SAVE_MS` later, or when its last editor leaves. By then
  that write is normally in storage, and a write that changes nothing is skipped; if the server
  that heard it died, the edit is not lost.
- Applying an update twice changes nothing, so a room that opens replays the stream from its start,
  to get what was changed since the last write-back.
- `agent` / `agent-ended`: the boards an Agent turn changed, appended by `run-artifacts` after each
  canvas write and at the turn's end. Each server drops one after `AGENT_PRESENCE_MS` if the turn
  never ends.

`artifacts.presence.<artifactId>` (1 minute, 1,000 records) carries `awareness`: what people point
at, as their server vouched for it. A server shares its people's states at most every
`AWARENESS_SHARE_MS`, each as it is by then, so moving cursors never push an update out of the
document's stream.

An update the stream no longer holds reaches storage with a write-back, so a server that missed it
gets it then.

## Lifetime

Once the last connection leaves and nothing waits to be written, the room closes and frees its
document. A client that reconnects later gets a room loaded from storage, with the same history, so
plain sync brings back what it changed while away. A connection holds at most
`MAX_LIVE_ARTIFACTS_PER_CONNECTION` artifacts. On server stop, every room writes back first.
