import type { Principal } from "../auth"
import type { SixbDependencies } from "../runtime/sixb"
import type { SixbRuntimeContext } from "../runtime/types"
import { AgentStorageError, type AgentThreadRecord } from "../storage/agents"
import { AgentRequestError } from "./errors"
import { createAgentThreadId, createAgentThreadSandboxName } from "./ids"
import { normalizeSandboxBinding } from "./sandbox"

/**
 * Copy a thread of the caller's, or one shared with them, into a new thread the caller owns alone.
 *
 * The caller has already checked that `source` is visible. A workspace binding is checked again
 * against the project's current sandbox definition, and the fork gets a sandbox of its own.
 */
export async function forkAgentThread(
  runtime: SixbRuntimeContext,
  input: {
    readonly source: AgentThreadRecord
    readonly ownerPrincipal: Principal
    readonly sandbox?: SixbDependencies["sandbox"]
  }
): Promise<AgentThreadRecord> {
  const storage = runtime.storage.agents
  if (!storage) {
    throw new AgentRequestError("storage_unavailable", "[Sixb] Agent storage is not configured.")
  }

  const { source, sandbox } = input
  if (source.sandboxParams !== undefined && !sandbox?.supportsPersistence) {
    throw new AgentRequestError(
      "sandbox_not_configured",
      "[Sixb] Thread sandboxes require a provider with persistence support."
    )
  }

  const id = createAgentThreadId()
  const sandboxParams =
    source.sandboxParams === undefined
      ? undefined
      : normalizeSandboxBinding(sandbox?.definition, source.sandboxParams, runtime.ontology)

  try {
    return await storage.threads.fork({
      projectId: runtime.projectId,
      sourceThreadId: source.id,
      id,
      ownerPrincipal: input.ownerPrincipal,
      ...(source.title === undefined ? {} : { title: source.title }),
      ...(sandboxParams === undefined
        ? {}
        : {
            sandboxParams,
            sandboxName: createAgentThreadSandboxName(runtime.projectId, id),
          }),
    })
  } catch (error) {
    if (error instanceof AgentStorageError && error.code === "thread_not_found") {
      throw new AgentRequestError(
        "thread_not_found",
        `[Sixb] Agent thread '${source.id}' not found.`
      )
    }

    throw error
  }
}
