import { AgentMemoryError, type AgentMemoryRepoView, type Sixb } from "@sixb/core"
import type { AgentMemoryPromptContext } from "./agent-prompt"
import {
  AGENT_MEMORY_ENTRY,
  AGENT_MEMORY_STARTER,
  type AgentMemoryRepo,
} from "./agent-runtime/memory"

/** The repos a conversation installs and shows, in the order the prompt lists them. */
const CONVERSATION_MEMORY_REPOS: readonly AgentMemoryRepo[] = ["user", "project"]

/** Others read a shared conversation, so whoever sends the turn, it reaches no one's own memory. */
const SHARED_CONVERSATION_MEMORY_REPOS: readonly AgentMemoryRepo[] = ["project"]

/** The Agent's memory for one conversational run. */
export interface ConversationMemory {
  /** Installed under `$SIXB_MEMORY_DIR` at their latest revision, for the Agent to read and save. */
  readonly repos: readonly AgentMemoryRepoView[]
  /** Each repo's `MEMORY.md` as of the time the prompt is frozen at. */
  readonly prompt: AgentMemoryPromptContext
}

/**
 * Load the repos the run's requester can read. The prompt shows each `MEMORY.md` as it was at
 * `asOf`, the start of the thread or its latest compaction, so a save leaves the prompt and its
 * cache as they are until the context is next compacted; the installed files are the latest.
 * A requester without a repo of its own, such as a service account, and a shared conversation get
 * the project's alone.
 */
export async function loadConversationMemory(input: {
  readonly sixb: Sixb
  readonly asOf: Date
  /** Others were added to the thread. */
  readonly shared?: boolean
}): Promise<ConversationMemory | undefined> {
  const { sixb, asOf, shared = false } = input
  const repos = shared ? SHARED_CONVERSATION_MEMORY_REPOS : CONVERSATION_MEMORY_REPOS
  const loaded = (
    await Promise.all(
      repos.map(async (repo) => {
        try {
          const [latest, then] = await Promise.all([
            sixb.agent.memory.get(repo),
            sixb.agent.memory.get(repo, { asOf }),
          ])
          return [{ latest, then }]
        } catch (error) {
          if (error instanceof AgentMemoryError && error.code === "not_allowed") return []
          throw error
        }
      })
    )
  ).flat()
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
