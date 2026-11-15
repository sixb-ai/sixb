import { isJsonObject } from "../json"
import type { AgentRunRecord, AgentStorage } from "../storage/agents"

/**
 * Whether the turn answered: it succeeded without asking a question the requester answers next.
 * Only after one does a message queued for later start; after any other end, only one sent now.
 */
export async function turnAnsweredEveryMessage(
  agents: AgentStorage,
  run: AgentRunRecord
): Promise<boolean> {
  if (run.status !== "succeeded") return false
  const { messages } = await agents.messages.list({
    projectId: run.projectId,
    threadId: run.threadId,
    roles: ["assistant"],
    order: "desc",
    limit: 1,
  })
  const answer = messages[0]
  if (!answer || answer.runId !== run.id) return true
  // `ask` answers `{ status: "asked" }`: the requester's next message is their answer, so a message
  // they queued instead is not one.
  return !answer.parts.some(
    (part) =>
      part.type === "tool-call" &&
      part.state === "output-available" &&
      isJsonObject(part.output) &&
      part.output.status === "asked"
  )
}
