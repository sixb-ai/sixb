import { createRuntimeArtifactAccessRule } from "../artifacts/execution"
import { createArtifactId } from "../artifacts/ids"
import type { Principal } from "../auth"
import type { SixbDependencies } from "../runtime/sixb"
import type { SixbRuntimeContext } from "../runtime/types"
import { AgentStorageError, type AgentThreadRecord } from "../storage/agents"
import { ArtifactStorageError } from "../storage/artifacts/errors"
import type { ArtifactStorage, CopyArtifactInput } from "../storage/artifacts/types"
import type { Storage } from "../storage/types"
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
    // One transaction: a fork that fails leaves no copy behind, and none copied is missing.
    return await runtime.storage.transaction(async (tx) => {
      const threads = tx.agents?.threads
      if (!threads) {
        throw new AgentRequestError(
          "storage_unavailable",
          "[Sixb] Agent storage is not configured."
        )
      }

      const artifactCopies = await copySharedArtifacts(runtime, tx, {
        sourceThreadId: source.id,
        forkId: id,
        owner: input.ownerPrincipal,
      })

      return threads.fork({
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
        ...(Object.keys(artifactCopies).length === 0 ? {} : { artifactCopies }),
      })
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

/**
 * The fork's own copies of the artifacts the source shares that the caller reads, by the artifact
 * access rule: every one for a signed-in session, only its own for an access token. Each copy has
 * every version under its number, so a copied card or an `@N` address still resolves; it reuses
 * the files, which blob storage keeps by content, is owned by whoever forks, and is shared in the
 * fork alone. A copy keeps its addresses: one naming another artifact still names the original.
 * Returns each source id with its copy's.
 */
async function copySharedArtifacts(
  runtime: SixbRuntimeContext,
  tx: Storage,
  input: {
    readonly sourceThreadId: string
    readonly forkId: string
    readonly owner: Principal
  }
): Promise<Record<string, string>> {
  const { projectId } = runtime
  const artifacts = tx.artifacts
  if (!artifacts) {
    const shared = await runtime.storage.artifacts?.list({
      projectId,
      threadId: input.sourceThreadId,
      limit: 1,
    })
    if (shared && shared.total > 0) {
      throw new AgentRequestError(
        "storage_unavailable",
        "[Sixb] Forking a conversation that shares artifacts needs artifacts and Agent threads in one storage."
      )
    }
    return {}
  }

  const access = createRuntimeArtifactAccessRule(runtime, tx)
  const copies: Record<string, string> = {}
  const { artifacts: shared } = await artifacts.list({ projectId, threadId: input.sourceThreadId })
  for (const artifact of shared) {
    if ((await access.accessTo(artifact)) === "none") continue

    copies[artifact.id] = await createCopy(artifacts, {
      projectId,
      sourceId: artifact.id,
      owner: input.owner,
      threadId: input.forkId,
    })
  }
  return copies
}

/** A copy of the artifact under a fresh id. */
async function createCopy(
  artifacts: ArtifactStorage,
  input: Omit<CopyArtifactInput, "id">
): Promise<string> {
  for (let attempt = 1; ; attempt += 1) {
    const id = createArtifactId()
    try {
      await artifacts.copy({ ...input, id })
      return id
    } catch (error) {
      const collided = error instanceof ArtifactStorageError && error.code === "artifact_exists"
      if (!collided || attempt === COPY_ATTEMPTS) throw error
    }
  }
}

const COPY_ATTEMPTS = 3
