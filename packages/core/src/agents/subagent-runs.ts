import type { AgentStorage, SubagentRunFile, SubagentRunRecord } from "../storage/agents"

const PAGE = 100

/**
 * A sub-agent's thread's runs, in the order they ran: by creation, then, for runs created in the
 * same instant, by where their trigger is in the thread. Runs are single-flight in a thread, so each
 * trigger follows the work of the runs before it. A run whose messages left the thread, an attempt
 * a retry removed, comes first among those created with it.
 */
export async function listSubagentThreadRuns(
  agents: AgentStorage,
  input: { readonly projectId: string; readonly threadId: string }
): Promise<readonly SubagentRunRecord[]> {
  const runs: SubagentRunRecord[] = []
  for (;;) {
    const page = await agents.runs.list({
      projectId: input.projectId,
      threadId: input.threadId,
      kinds: ["subagent"],
      order: "asc",
      limit: PAGE,
      offset: runs.length,
    })
    runs.push(...page.runs.filter((run) => run.kind === "subagent"))
    if (!page.hasMore || page.runs.length === 0) break
  }

  const triggers = await Promise.all(
    runs.map((run) =>
      agents.messages.getById({ projectId: input.projectId, id: run.triggerMessageId })
    )
  )
  const seqOf = new Map(runs.map((run, index) => [run.id, triggers[index]?.seq ?? -1]))
  return runs.sort(
    (a, b) =>
      a.createdAt.getTime() - b.createdAt.getTime() ||
      (seqOf.get(a.id) ?? -1) - (seqOf.get(b.id) ?? -1) ||
      a.id.localeCompare(b.id)
  )
}

/**
 * The files a child finds in its sandbox: those its parent handed over, and for a continuation
 * what the paused run left in `out/`, given back there. An output wins over a handed file at its
 * path, as the paused run's copy was the latest.
 */
export function subagentSandboxFiles(
  run: SubagentRunRecord,
  paused: SubagentRunRecord | undefined
): readonly SubagentRunFile[] {
  const outputs = (paused?.result?.files ?? []).map((file) => ({
    ...file,
    path: `out/${file.path}`,
  }))
  const restored = new Set(outputs.map((file) => file.path))

  return [...(run.spec.files ?? []).filter((file) => !restored.has(file.path)), ...outputs]
}
