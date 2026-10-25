import { createHash, randomUUID } from "node:crypto"

/**
 * Id helpers for agent persistence. Threads, the run id, and the user (trigger) message are minted
 * by the trigger; the queued run is persisted with the user message, and the assistant message id
 * is minted when the turn finalizes. Prefixes make ids self-describing in logs.
 */

export function createAgentThreadId(): string {
  return `agt_thr_${randomUUID()}`
}

/** A fresh provider name, scoped to one project's thread; never a filesystem revision. */
export function createAgentThreadSandboxName(projectId: string, threadId: string): string {
  const digest = createHash("sha256")
    .update(JSON.stringify([projectId, threadId, randomUUID()]))
    .digest("hex")
  return `sixb-sb-${digest}`
}

export function createAgentRunId(): string {
  return `agt_run_${randomUUID()}`
}

/** One stable child identity per parent-selected spawn key. */
export function createSubagentRunId(parentRunId: string, spawnKey: string): string {
  return `agt_run_child_${spawnDigest(parentRunId, spawnKey)}`
}

/**
 * The thread a child works in, named after the turn that spawned it and its key. It shares its
 * first run's digest: migration `subagent-threads` names the threads of earlier children so.
 */
export function createSubagentThreadId(spawningRunId: string, spawnKey: string): string {
  return `agt_thr_child_${spawnDigest(spawningRunId, spawnKey)}`
}

function spawnDigest(runId: string, spawnKey: string): string {
  return createHash("sha256").update(runId).update("\0").update(spawnKey).digest("hex")
}

/** Stable execution identity paired with a deterministic child run. */
export function createSubagentExecutionId(runId: string): string {
  return `exec_${runId}`
}

export function createAgentMessageId(): string {
  return `agt_msg_${randomUUID()}`
}

/** One deterministic context-checkpoint identity per conversational run. */
export function agentContextCheckpointId(runId: string): string {
  return `agt_ctx_${runId}`
}

/** A checkpoint copied into a fork; the source's checkpoint keeps its run-derived id. */
export function createCopiedAgentContextCheckpointId(): string {
  return `agt_ctx_copy_${randomUUID()}`
}

/** A queue delivery's fencing token for writes to an `agent_runs` record. */
export function createAgentRunExecutionToken(): string {
  return `agt_exec_${randomUUID()}`
}
