import type { MaterializationSession } from "../materializations"
import type { OntologyVectorIndexingStorage, VectorIndexingWork } from "../vector-indexing"

export class InMemoryVectorIndexingStorage implements OntologyVectorIndexingStorage {
  constructor(
    private readonly state: Map<
      string,
      VectorIndexingWork & { projectId: string; dispatchAt: string }
    >,
    private readonly assertSession: (session: MaterializationSession, projectId: string) => void,
    private readonly run: <T>(fn: () => T) => Promise<T>
  ) {}

  async schedule(input: Parameters<OntologyVectorIndexingStorage["schedule"]>[0]) {
    this.assertSession(input.session, input.projectId)
    if (input.deleted.length) {
      const deleted = new Set(
        input.deleted.map((ref) => JSON.stringify([ref.objectTypeId, ref.primaryId]))
      )
      for (const [key, work] of this.state) {
        if (
          work.projectId === input.projectId &&
          deleted.has(JSON.stringify([work.ref.objectTypeId, work.ref.primaryId]))
        )
          this.state.delete(key)
      }
    }
    for (const request of input.requests) {
      const key = JSON.stringify([
        input.projectId,
        request.ref.objectTypeId,
        request.ref.primaryId,
        request.profile,
      ])
      this.state.set(
        key,
        structuredClone({
          ...request,
          projectId: input.projectId,
          status: "pending",
          availableAt: input.availableAt,
          dispatchAt: input.availableAt,
        })
      )
    }
  }

  async complete(input: Parameters<OntologyVectorIndexingStorage["complete"]>[0]) {
    this.assertSession(input.session, input.projectId)
    const key = JSON.stringify([
      input.projectId,
      input.ref.objectTypeId,
      input.ref.primaryId,
      input.profile,
    ])
    const work = this.state.get(key)
    if (
      work?.configuration === input.configuration &&
      work.sourceFingerprint === input.sourceFingerprint
    )
      this.state.delete(key)
  }
  async dispatched(input: Parameters<OntologyVectorIndexingStorage["dispatched"]>[0]) {
    await this.run(() => {
      for (const [key, work] of this.state)
        if (work.projectId === input.projectId && input.ids.includes(work.id))
          this.state.set(key, { ...work, dispatchAt: input.nextDispatchAt })
    })
  }
  async get(input: Parameters<OntologyVectorIndexingStorage["get"]>[0]) {
    return this.run(() =>
      structuredClone(
        [...this.state.values()].find(
          (work) => work.projectId === input.projectId && work.id === input.id
        ) ?? null
      )
    )
  }

  async listDue(input: Parameters<OntologyVectorIndexingStorage["listDue"]>[0]) {
    return this.run(() =>
      [...this.state.values()]
        .filter(
          (work) =>
            work.projectId === input.projectId &&
            work.status !== "failed" &&
            work.dispatchAt <= input.now
        )
        .sort((a, b) => a.dispatchAt.localeCompare(b.dispatchAt) || a.id.localeCompare(b.id))
        .slice(0, input.limit)
        .map(({ values: _values, ...work }) => structuredClone(work))
    )
  }

  async update(input: Parameters<OntologyVectorIndexingStorage["update"]>[0]) {
    return this.run(() => {
      for (const [key, work] of this.state) {
        if (
          work.projectId !== input.projectId ||
          work.id !== input.id ||
          work.status !== input.expectedStatus
        )
          continue
        this.state.set(
          key,
          structuredClone({
            ...work,
            status: input.status,
            availableAt: input.availableAt,
            values: input.values ?? work.values,
            error: input.error,
          })
        )
        return true
      }
      return false
    })
  }

  async remove(input: Parameters<OntologyVectorIndexingStorage["remove"]>[0]) {
    await this.run(() => {
      for (const [key, work] of this.state)
        if (work.projectId === input.projectId && work.id === input.id) this.state.delete(key)
    })
  }
}
