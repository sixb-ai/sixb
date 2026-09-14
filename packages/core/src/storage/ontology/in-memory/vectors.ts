import { MaterializationConflictError } from "../../../materialization/errors"
import type { MaterializationSession } from "../materializations"
import type { OntologyVectorStorage, StoredObjectVector } from "../vectors"

export function vectorObjectKey(projectId: string, ref: StoredObjectVector["ref"]): string {
  return JSON.stringify([projectId, ref.objectTypeId, ref.primaryId])
}

export class InMemoryOntologyVectorStorage implements OntologyVectorStorage {
  constructor(
    private readonly state: Map<string, Map<string, StoredObjectVector>>,
    private readonly assertSession: (
      session: MaterializationSession,
      projectId: string,
      commitId?: string
    ) => void,
    private readonly runRootOperation: <T>(run: () => T) => Promise<T>
  ) {}

  async list(input: Parameters<OntologyVectorStorage["list"]>[0]) {
    return this.runRootOperation(() =>
      [...(this.state.get(vectorObjectKey(input.projectId, input.ref))?.values() ?? [])].map(
        ({ values: _values, ...metadata }) => structuredClone(metadata)
      )
    )
  }

  async write(input: Parameters<OntologyVectorStorage["write"]>[0]) {
    this.assertSession(input.session, input.projectId, input.value.lastCommitId)
    const key = vectorObjectKey(input.projectId, input.value.ref)
    const profiles = this.state.get(key) ?? new Map<string, StoredObjectVector>()
    this.assertRevision(profiles.get(input.value.profile), input.expectedCommitId)
    profiles.set(input.value.profile, structuredClone(input.value))
    this.state.set(key, profiles)
  }

  async remove(input: Parameters<OntologyVectorStorage["remove"]>[0]) {
    this.assertSession(input.session, input.projectId)
    const key = vectorObjectKey(input.projectId, input.ref)
    const profiles = this.state.get(key)
    this.assertRevision(profiles?.get(input.profile), input.expectedCommitId)
    profiles?.delete(input.profile)
    if (profiles?.size === 0) this.state.delete(key)
  }

  private assertRevision(current: StoredObjectVector | undefined, expected: string | null) {
    if ((current?.lastCommitId ?? null) !== expected) {
      throw new MaterializationConflictError(
        "effective-state",
        "Vector changed since it was prepared."
      )
    }
  }
}
