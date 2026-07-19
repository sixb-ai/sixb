import type {
  GetOntologyCommitByIdempotencyKeyInput,
  GetOntologyCommitByIdInput,
  OntologyCommitRecord,
  OntologyCommitStorage,
} from "../commits"
import { commitKey, type InMemoryOntologyState, idempotencyKey } from "./shared-state"

export class InMemoryOntologyCommitStorage implements OntologyCommitStorage {
  constructor(
    private readonly state: InMemoryOntologyState,
    private readonly runRootOperation: <T>(run: () => Promise<T> | T) => Promise<T>
  ) {}

  async getByIdempotencyKey(
    input: GetOntologyCommitByIdempotencyKeyInput
  ): Promise<OntologyCommitRecord | null> {
    return this.runRootOperation(() => {
      const id = this.state.commitIdByIdempotency.get(
        idempotencyKey(input.projectId, input.idempotencyKey)
      )
      if (!id) return null
      return structuredClone(this.state.commitsById.get(commitKey(input.projectId, id)) ?? null)
    })
  }

  async getById(input: GetOntologyCommitByIdInput): Promise<OntologyCommitRecord | null> {
    return this.runRootOperation(() =>
      structuredClone(this.state.commitsById.get(commitKey(input.projectId, input.id)) ?? null)
    )
  }
}
