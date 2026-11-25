import type { SixbBranch } from "../branch-mode"
import { putOnBranch } from "../branch-mode"
import type { LakeStorage } from "../lake-storage/types"
import { hostOptionsOf, SixbHost, type SixbHostView } from "../runtime/host"
import type { Storage } from "../storage/types"
import { branchBlobStorage } from "./blobs"

/** What a branch on a laptop knows of production, as `sixb dev --from production` set it up. */
export interface BranchRuntime {
  /** The person the copy was taken as: every local request runs as them. */
  readonly person: { readonly userId: string }
  /** Production's API, read as that person: its object files, and its lake's slice token. */
  readonly production: {
    readonly url: string
    authorization(): Promise<string>
  }
  /** When the copy was taken: the branch's data is production's as of then. */
  readonly takenAt: string
}

const runtimes = new WeakMap<object, BranchRuntime>()

/** The branch runtime a host runs on, or null off a branch from production. */
export function branchRuntimeOf(host: object): BranchRuntime | null {
  return runtimes.get(host) ?? null
}

/**
 * The project's host, built again on the branch's own data: its storage namespace and its lake
 * slice in place of the providers the project configured, everything else as the project wrote
 * it. The host must already run as a branch, so every gate is on.
 */
export function hostOnBranch(
  host: SixbHostView,
  input: {
    readonly storage: Storage
    readonly lakeStorage?: LakeStorage
    readonly runtime: BranchRuntime
  }
): SixbHost {
  const branch: SixbBranch | null = host.branch
  if (!branch) {
    throw new Error("[Sixb] Only a host that runs as a branch is built on a branch's data.")
  }

  const base = hostOptionsOf(host as SixbHost)
  const options = putOnBranch(
    {
      ...base,
      storage: input.storage,
      ...(input.lakeStorage ? { lakeStorage: input.lakeStorage } : {}),
      // The copied objects' files stay in production: whatever reads them on the branch reads
      // them from there, as the person.
      blobStorage: branchBlobStorage({
        local: base.blobStorage,
        runtime: input.runtime,
        projectId: host.projectId,
        objects: input.storage.objects,
        objectTypes: () => host.definitions.ontology.listObjectTypes(),
      }),
    },
    branch
  )
  const branchHost = new SixbHost(options)
  runtimes.set(branchHost, input.runtime)
  return branchHost
}
