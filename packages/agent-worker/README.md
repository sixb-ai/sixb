# @sixb/agent-worker

The cohosted worker that turns `agent.run.requested` queue jobs into persisted agent runs.

A trigger (`sixb.agents.request(...)`) persists the user message and enqueues an *intent*; this worker
claims it, mints the run + lease (**reserve-at-claim**, so there is never an orphan run), streams the
model with the AI SDK, and persists the assistant message + finalizes the run.

## Liveness (two layers)

- The **queue lane** delivers and redelivers (on lease expiry).
- The **`agent_runs` lease** is the sole authority on who may write — every write is fenced on the
  lease id, kept fresh by a heartbeat during the turn.

## Run fate

A run's terminal state lives on its record:

- **model/tool failure** → `failed`, job acked;
- **shutdown** → `cancelled`, job released for another process;
- **turn timeout** (`turnTimeoutMs`, default 5 min) → `failed`, thread released;
- **lease lost mid-turn** (reclaimed as a suspected crash) → writes nothing, acks the duplicate;
- **finalize cannot be recorded** (storage unavailable) → the job is **not** acked; it is redelivered
  (bounded) so a later delivery finalizes the run, rather than leaving the thread silently locked.

## Not in this package

HTTP/WebSocket surface, broker streaming (the `StreamSink` seam is a no-op by default), and the real
sandbox + tools live in later slices.
