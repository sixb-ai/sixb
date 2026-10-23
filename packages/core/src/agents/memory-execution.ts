import { type Principal, SYSTEM_PRINCIPAL } from "../auth"
import { isRuntimeAllowed } from "../authorization"
import { resolveRuntimeAuthorizationForProject } from "../execution/authorization"
import type { SixbRuntimeContext } from "../runtime/types"
import type {
  AgentMemoryChange,
  AgentMemoryFile,
  AgentMemoryStore,
  ListAgentMemoryRevisionsResult,
} from "../storage/agents"
import { AgentMemoryError } from "./errors"
import {
  type AgentMemoryLinkWarning,
  type AgentMemoryRepoName,
  agentMemoryRepoId,
  applyAgentMemoryChanges,
  findBrokenAgentMemoryLinks,
} from "./memory"

/** A memory repo as the caller sees it. */
export interface AgentMemoryRepoView {
  readonly repo: AgentMemoryRepoName
  /** 0 before the first save. */
  readonly revision: number
  /** Ordered by path. */
  readonly files: readonly AgentMemoryFile[]
}

export interface SaveAgentMemoryRuntimeInput {
  /** The revision the changes were made against. */
  readonly baseRevision: number
  /** What was learned, as the revision's entry in the repo's history. */
  readonly message: string
  /** `contents: null` deletes the file. */
  readonly changes: readonly AgentMemoryChange[]
  /** The conversation the save came from, `/agents/<threadId>`. */
  readonly source?: string
}

export type SaveAgentMemoryRuntimeResult =
  | {
      readonly saved: true
      readonly revision: number
      /** Links in the saved repo that point at no file. */
      readonly warnings: readonly AgentMemoryLinkWarning[]
    }
  | {
      readonly saved: false
      /** The repo's latest revision. */
      readonly revision: number
      /** Files in `changes` that another save changed after `baseRevision`, as they are now. */
      readonly conflicts: readonly AgentMemoryChange[]
    }

/**
 * The Agent's memory: `user` is the caller's own; `project` is built up by everyone who can run the
 * Agent, who all read and save it, and deleted only with `can.manage(agent.memory)`.
 */
export interface AgentMemoryRuntime {
  /**
   * With `asOf`, the repo at the latest revision saved by then; with `revision`, as that revision
   * left it.
   */
  get(
    repo: AgentMemoryRepoName,
    options?: { readonly asOf?: Date; readonly revision?: number }
  ): Promise<AgentMemoryRepoView>
  save(
    repo: AgentMemoryRepoName,
    input: SaveAgentMemoryRuntimeInput
  ): Promise<SaveAgentMemoryRuntimeResult>
  /** Newest first. */
  listRevisions(
    repo: AgentMemoryRepoName,
    input?: { readonly limit?: number; readonly offset?: number }
  ): Promise<ListAgentMemoryRevisionsResult>
  /** Deletes the repo with its history. */
  delete(repo: AgentMemoryRepoName): Promise<void>
}

const SOURCE_PATTERN = /^\/agents\/[A-Za-z0-9_-]{1,128}$/

export function createAgentMemoryRuntime(runtime: SixbRuntimeContext): AgentMemoryRuntime {
  const authority = resolveRuntimeAuthorizationForProject(runtime)
  // Shared-link sessions and unresolved authority reach no memory.
  const caller: Principal | null =
    authority.type === "principal"
      ? authority.context.principal
      : authority.type === "unrestricted"
        ? SYSTEM_PRINCIPAL
        : null

  const requireStorage = (): AgentMemoryStore => {
    const storage = runtime.storage.agents?.memory
    if (!storage) {
      throw new AgentMemoryError(
        "storage_unavailable",
        "[Sixb] Agent memory needs storage that supports the Agent."
      )
    }
    return storage
  }

  const canManageProject = () => isRuntimeAllowed(runtime, { kind: "agentMemory.manage" })

  /** The repo's storage id, once the caller may read and save it. */
  const usable = (repo: AgentMemoryRepoName): string => {
    if (
      repo === "project" &&
      !isRuntimeAllowed(runtime, { kind: "agent.run" }) &&
      !canManageProject()
    ) {
      throw new AgentMemoryError(
        "not_allowed",
        "[Sixb] The project's Agent memory needs can.run(agent) or can.manage(agent.memory)."
      )
    }
    return agentMemoryRepoId(repo, caller)
  }

  /** The repo's storage id, once the caller may delete it with its history. */
  const deletable = (repo: AgentMemoryRepoName): string => {
    const repoId = usable(repo)
    if (repo === "project" && !canManageProject()) {
      throw new AgentMemoryError(
        "not_allowed",
        "[Sixb] Deleting the project's Agent memory needs can.manage(agent.memory)."
      )
    }
    return repoId
  }

  return {
    async get(repo, options = {}) {
      const repoId = usable(repo)
      const { revision, files } = await requireStorage().get({
        projectId: runtime.projectId,
        repoId,
        ...(options.asOf === undefined ? {} : { asOf: options.asOf }),
        ...(options.revision === undefined ? {} : { revision: options.revision }),
      })
      return { repo, revision, files }
    },

    async save(repo, input) {
      const repoId = usable(repo)
      if (!Number.isSafeInteger(input.baseRevision) || input.baseRevision < 0) {
        throw new AgentMemoryError(
          "invalid_save",
          "[Sixb] Agent memory base revision must be the revision the changes were made against."
        )
      }
      if (input.source !== undefined && !SOURCE_PATTERN.test(input.source)) {
        throw new AgentMemoryError(
          "invalid_save",
          "[Sixb] Agent memory source must be a conversation link, '/agents/<threadId>'."
        )
      }
      const storage = requireStorage()
      const current = await storage.get({ projectId: runtime.projectId, repoId })
      const files = applyAgentMemoryChanges(current.files, input.message, input.changes)
      const result = await storage.save({
        projectId: runtime.projectId,
        repoId,
        baseRevision: input.baseRevision,
        message: input.message.trim(),
        author: caller ?? SYSTEM_PRINCIPAL,
        ...(input.source === undefined ? {} : { source: input.source }),
        changes: input.changes,
      })
      return result.saved ? { ...result, warnings: findBrokenAgentMemoryLinks(files) } : result
    },

    async listRevisions(repo, input = {}) {
      return requireStorage().listRevisions({
        projectId: runtime.projectId,
        repoId: usable(repo),
        ...input,
      })
    },

    async delete(repo) {
      await requireStorage().delete({ projectId: runtime.projectId, repoId: deletable(repo) })
    },
  }
}
