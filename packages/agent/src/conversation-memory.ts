import { AGENT_MEMORY_ENTRY, AGENT_MEMORY_STARTER } from "@sixb/cli-core"
import type { AgentMemoryRepoView } from "@sixb/core"
import type { AgentRunSession } from "@sixb/core/internal/agents"
import type { AgentMemoryPromptContext } from "./agent-prompt"

/** The Agent's memory for one conversational run. */
export interface ConversationMemory {
  /** Installed under `$SIXB_MEMORY_DIR` at their latest revision, for the Agent to read and save. */
  readonly repos: readonly AgentMemoryRepoView[]
  /** Each repo's `MEMORY.md` as of the time the prompt is frozen at. */
  readonly prompt: AgentMemoryPromptContext
}

/**
 * The repos the run's requester can read, through its session. The prompt shows each `MEMORY.md` as
 * it was at `asOf`, the start of the thread or its latest compaction, so a save leaves the prompt
 * and its cache as they are until the context is next compacted; the installed files are the
 * latest.
 */
export async function loadConversationMemory(input: {
  readonly session: Pick<AgentRunSession, "memory">
  readonly asOf: Date
}): Promise<ConversationMemory | undefined> {
  const { shared, repos: loaded } = await input.session.memory({ asOf: input.asOf })
  if (loaded.length === 0) return undefined

  return {
    repos: loaded.map(({ latest }) => latest),
    prompt: {
      ...(shared ? { shared } : {}),
      repos: loaded.map(({ latest, then }) => ({
        repo: latest.repo,
        // A version pruned from the history since is shown as it is now.
        entry:
          entryOf(then) ??
          (then.revision === 0 ? undefined : entryOf(latest)) ??
          AGENT_MEMORY_STARTER,
      })),
    },
  }
}

function entryOf(repo: AgentMemoryRepoView): string | undefined {
  return repo.files.find((file) => file.path === AGENT_MEMORY_ENTRY)?.contents
}
