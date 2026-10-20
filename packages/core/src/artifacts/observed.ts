import { assertAuthorized } from "../authorization"
import type { SixbRuntimeContext } from "../runtime/types"
import type {
  ArtifactRecord,
  ArtifactVersionRecord,
  ListArtifactVersionsResult,
} from "../storage/artifacts/types"
import { paginate } from "../storage/pagination"

/**
 * What the Agent published in anyone's conversation, read-only, for a caller with
 * `can.observe(agent.threads)`. Only the versions a conversation published exist here: the
 * artifact's record, its latest version and its counts are those of these versions alone.
 */
export interface ObservedAgentArtifactsRuntime {
  /** Titled and numbered by its latest conversation version; `null` when it has none. */
  get(artifactId: string): Promise<ArtifactRecord | null>
  /** `"latest"` is the latest conversation version. */
  getVersion(artifactId: string, version: number | "latest"): Promise<ArtifactVersionRecord | null>
  /** Newest first; `null` when the artifact has no conversation version. */
  listVersions(
    artifactId: string,
    input?: { readonly limit?: number; readonly offset?: number }
  ): Promise<ListArtifactVersionsResult | null>
}

/**
 * A version a conversation published. Only the Agent's publish tool stores an origin, and only in
 * a conversation run, with that run's thread and id: `sixb.artifacts` and `POST /api/artifacts`
 * take none. An origin naming its thread and run is therefore a version the Agent showed someone.
 */
function fromConversation(version: ArtifactVersionRecord): boolean {
  return Boolean(version.origin?.threadId && version.origin.runId)
}

export function createObservedAgentArtifactsRuntime(
  runtime: SixbRuntimeContext
): ObservedAgentArtifactsRuntime {
  const { projectId } = runtime

  // Every version, read whole as an owner's version list is, then kept to the conversations'.
  const conversationVersions = async (
    artifactId: string
  ): Promise<{ artifact: ArtifactRecord; versions: ArtifactVersionRecord[] } | null> => {
    assertAuthorized(runtime, { kind: "agentThreads.observe" })

    const storage = runtime.storage.artifacts
    const artifact = await storage?.get({ projectId, id: artifactId })
    if (!storage || !artifact) {
      return null
    }

    const { versions } = await storage.listVersions({ projectId, artifactId })
    const published = versions.filter(fromConversation)
    return published.length === 0 ? null : { artifact, versions: published }
  }

  return {
    async get(artifactId) {
      const read = await conversationVersions(artifactId)
      const latest = read?.versions[0]
      if (!read || !latest) {
        return null
      }

      return {
        ...read.artifact,
        title: latest.title,
        latestVersion: latest.version,
        updatedAt: latest.createdAt,
      }
    },

    async getVersion(artifactId, version) {
      if (version === "latest") {
        return (await conversationVersions(artifactId))?.versions[0] ?? null
      }

      assertAuthorized(runtime, { kind: "agentThreads.observe" })
      const record = await runtime.storage.artifacts?.getVersion({ projectId, artifactId, version })
      return record && fromConversation(record) ? record : null
    },

    async listVersions(artifactId, input = {}) {
      const read = await conversationVersions(artifactId)
      if (!read) {
        return null
      }

      const { page, hasMore, total } = paginate(read.versions, input)
      return { versions: page, hasMore, total }
    },
  }
}
