import { createArtifactId } from "../artifacts/ids"
import type { Principal } from "../auth"
import type { SixbDependencies } from "../runtime/sixb"
import type { SixbRuntimeContext } from "../runtime/types"
import { AgentStorageError, type AgentThreadRecord } from "../storage/agents"
import { ArtifactStorageError } from "../storage/artifacts/errors"
import type { ArtifactStorage, CreateArtifactInput } from "../storage/artifacts/types"
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

      const artifactCopies = await copySharedArtifacts(runtime, tx.artifacts, {
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
 * The fork's own copies of the artifacts the source shares: each at its latest version, owned by
 * whoever forks, shared in the fork alone. A copy reuses the version's files, which blob storage
 * keeps by content, and keeps its addresses: one naming another artifact still names the original.
 * Returns each source id with its copy's.
 */
async function copySharedArtifacts(
  runtime: SixbRuntimeContext,
  artifacts: ArtifactStorage | undefined,
  input: {
    readonly sourceThreadId: string
    readonly forkId: string
    readonly owner: Principal
  }
): Promise<Record<string, string>> {
  const { projectId } = runtime
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

  const copies: Record<string, string> = {}
  const { artifacts: shared } = await artifacts.list({ projectId, threadId: input.sourceThreadId })
  for (const artifact of shared) {
    const latest = await artifacts.getVersion({
      projectId,
      artifactId: artifact.id,
      version: artifact.latestVersion,
    })
    if (!latest) continue

    const {
      projectId: _project,
      artifactId: _artifact,
      version: _number,
      origin: _origin,
      ...content
    } = latest
    const copy = await createCopy(artifacts, {
      projectId,
      kind: artifact.kind,
      owner: input.owner,
      version: { ...content, createdAt: new Date() },
    })
    await artifacts.shareInThread({ projectId, artifactId: copy, threadId: input.forkId })
    copies[artifact.id] = copy
  }
  return copies
}

/** A new artifact with the copied version as its first, under a fresh id. */
async function createCopy(
  artifacts: ArtifactStorage,
  input: Omit<CreateArtifactInput, "id">
): Promise<string> {
  for (let attempt = 1; ; attempt += 1) {
    const id = createArtifactId()
    try {
      await artifacts.create({ ...input, id })
      return id
    } catch (error) {
      const collided = error instanceof ArtifactStorageError && error.code === "artifact_exists"
      if (!collided || attempt === COPY_ATTEMPTS) throw error
    }
  }
}

const COPY_ATTEMPTS = 3
