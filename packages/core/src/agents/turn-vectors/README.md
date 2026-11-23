# Conversation turn vectors

Each turn of a conversation is embedded so the Agent can find earlier conversations by meaning.
It exists only when the project registers a model in `models.embedding` (the first one is used)
and the storage can search vectors (`turnVectors.searchAvailable()`: pgvector in `public`,
sqlite-vec loadable, always in memory). Otherwise nothing is indexed.

```text
turns.ts           messages → turns → the text each embeds, in chunks
configuration.ts   the fingerprint every vector carries
indexing.ts        the job, the request after a turn ends, the repair pass
```

## What a turn is

A turn opens at a message a person wrote with text or a file, and runs to the next one. A steer
opens its own; the message resuming a paused turn, or asking to continue a cut answer, does not.
It embeds the request, the final answer (`answerOfSteps`: text after the last local tool call) and
the titles of what its runs published. Tool calls, their output and reasoning are left out. A text
over 8,000 characters (the search query's cap) or the model's input bytes is cut into chunks, each
opening with the request. Sub-agents' threads are never indexed.

## How it stays current

- **Revision.** `agent_threads.message_revision` moves with every message added or taken. A write
  names the revision it read the thread at, and is dropped once it moved. `indexed_revision` is the
  revision last indexed whole: a thread where the two differ is behind, and a partial index lists
  exactly those.
- **Tail.** Indexing reads from the first message of the newest turn indexed, which may have
  grown since (a resumed turn), not from the start. A turn whose text did not change keeps its
  vector: only new text is paid for.
- **Deletions.** Vectors are keyed by the turn's opening message, never by `seq`, which a retry or
  an edit reuses. Deleting that message deletes its vectors (`ON DELETE CASCADE`). A retry keeps the
  opening message and takes the answer: every deletion records `stale_from_seq`, and indexing goes
  back to the turn that held it.
- **Fork.** A fork copies the vectors of the messages it copies, onto the copies. It is current
  when the source was; otherwise it goes on from where the source stood.
- **Model.** Another fingerprint is stale: the first write under the new one drops the old vectors.
- **Part way.** Turns are written as each call's embeddings come back, so an AI limit reached part
  way keeps what was paid for; the thread stays behind and resumes at the newest turn written.

## Jobs

`agent.thread.index.requested` runs in the agent worker. There is one job id per thread, always
asked for with `replace`: a waiting job takes the newest ask, and a claimed one keeps its delivery
while the ask waits behind it. So two workers never index one thread at once, and never pay twice
for the same turns. A lease on the index state would do the same with one more write per job; the
queue already holds the id.

A turn's end asks for its thread (`afterAgentRunFinished`, after the next turn has started). The
worker's 30-second repair pass asks for up to 200 idle conversations behind, most recently active
first: ends a crash lost, a model change, and every conversation from before indexing existed. It
reads two indexes, threads behind their revision and threads of another configuration, never all
threads.

Indexing is the project's work, not a person's: it runs as the kernel operation
`agents.indexTurns`, on one execution per thread (`exec_turns_<threadId>`) that each job records
its calls under. Only the project's AI limits admit its calls, and Settings › Usage shows them with
no requester, as it shows object vectors and media transcription. No one's own usage or limit ever
counts them, whoever wrote the turns, in a shared conversation or a fork. One call embeds several
turns, up to the model's batch limits.

The project's limit refusing a call defers the thread to its reset (at least a minute); any other failure
defers it 1 minute, 5, 30, then every 6 hours, never giving up. The deferral is recorded on the
thread (`deferred_until`, `failures`), so neither the repair pass nor a turn's end asks for it
meanwhile, and the job waits until then. A call whose outcome is unknown is recorded as such and
may be paid again on the next try. A write clears both.
