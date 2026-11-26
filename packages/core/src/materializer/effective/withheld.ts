import type { EffectiveObjectSnapshot } from "../../materialization/model"
import type { OntologyCommitStorage, SnapshotWithheldProperties } from "../../storage/ontology"
import { SNAPSHOT_COMMIT_ID_PREFIX } from "../../storage/ontology/commits"

/** The required properties a branch's copy left out of one object, and who took the copy. */
export interface WithheldFromObject {
  readonly takenBy: string
  readonly propertyIds: readonly string[]
}

/**
 * What a branch's copy withheld, read from its base commit.
 *
 * An object nothing wrote since the import still names that commit as its last, so only those
 * objects cost a read, and once per commit: a commit never changes. Production holds no snapshot
 * commit and reads nothing.
 */
export class WithheldProperties {
  readonly #commits = new Map<string, SnapshotWithheldProperties | null>()

  /** Read what the base commits of these objects withheld, before their writes are validated. */
  async load(
    commits: OntologyCommitStorage,
    projectId: string,
    objects: Iterable<EffectiveObjectSnapshot | null>
  ): Promise<void> {
    for (const object of objects) {
      const commitId = object?.lastCommitId
      if (!commitId?.startsWith(SNAPSHOT_COMMIT_ID_PREFIX) || this.#commits.has(commitId)) continue

      const commit = await commits.getById({ projectId, id: commitId })
      const withheld = commit?.intent.kind === "edit" ? commit.intent.withheld : undefined
      this.#commits.set(commitId, withheld ?? null)
    }
  }

  /** What the copy withheld from this object, once `load` read its commit. */
  of(object: EffectiveObjectSnapshot | null): WithheldFromObject | undefined {
    if (!object) return undefined

    const withheld = this.#commits.get(object.lastCommitId)
    const propertyIds = withheld?.properties[object.ref.objectTypeId]
    if (!withheld || !propertyIds) return undefined

    return { takenBy: withheld.takenBy, propertyIds }
  }
}
