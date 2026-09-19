import { MaterializationConflictError } from "../../../materialization/errors"
import { linkScopeSortKey, projectionEntityKey } from "../../../materialization/refs"
import type { SourceActivationWrite } from "../materializations"
import type { StoredSourceAssertion, StoredSourceLinkAssertion } from "../sources"
import { storedSource } from "./materializations-state"
import {
  type InMemoryOntologyState,
  type InMemorySourceMaterialization,
  projectEntityKey,
  sourceMaterializationKey,
} from "./shared-state"

export function* previousSourceRows(
  state: InMemoryOntologyState,
  candidate: InMemorySourceMaterialization
): Iterable<StoredSourceAssertion> {
  const sourceKey = projectEntityKey(candidate.projectId, candidate.source.projectionId)
  const active = state.activeSourceRoots.get(sourceKey)
  if (!active) return
  for (const rootKey of candidate.base ? candidate.roots.keys() : active.keys()) {
    const materializationId = active.get(rootKey)
    if (!materializationId) continue
    const materialization = state.sourceMaterializations.get(
      sourceMaterializationKey(
        candidate.projectId,
        candidate.source.projectionId,
        materializationId
      )
    )!
    for (const entityKey of materialization.roots.get(rootKey)!.entityKeys) {
      yield storedSource(
        candidate.source.projectionId,
        materializationId,
        materialization.rowsByEntity.get(entityKey)!
      )
    }
  }
}

export function activateSourceRoots(
  state: InMemoryOntologyState,
  candidate: InMemorySourceMaterialization,
  activation: SourceActivationWrite
): void {
  if (
    candidate.base &&
    (candidate.base.materializationId !== activation.expected.activeMaterializationId ||
      candidate.base.lastCommitId !== activation.expected.lastCommitId)
  ) {
    throw new MaterializationConflictError(
      "projection-fence",
      "Source delta base changed before activation."
    )
  }
  const sourceKey = projectEntityKey(candidate.projectId, candidate.source.projectionId)
  const active = state.activeSourceRoots.get(sourceKey) ?? new Map<string, string>()
  for (const key of candidate.base ? candidate.roots.keys() : [...active.keys()]) {
    const materializationId = active.get(key)
    if (!materializationId) continue
    const old = state.sourceMaterializations.get(
      sourceMaterializationKey(
        candidate.projectId,
        candidate.source.projectionId,
        materializationId
      )
    )!
    const root = old.roots.get(key)!
    root.active = false
    root.retiredAt = activation.updatedAt
    active.delete(key)
    for (const entityKey of root.entityKeys) {
      const row = old.rowsByEntity.get(entityKey)!
      const indexKey = projectEntityKey(candidate.projectId, entityKey)
      const sources = state.activeSourceRows.get(indexKey)!
      sources.delete(candidate.source.projectionId)
      if (sources.size === 0) state.activeSourceRows.delete(indexKey)
      if (row.assertion.kind === "link") {
        const scopeKey = projectEntityKey(
          candidate.projectId,
          linkScopeSortKey(row.assertion.ref.source, row.assertion.ref.linkId)
        )
        const scope = state.activeSourceLinkScopes.get(scopeKey)!
        scope.delete(JSON.stringify([candidate.source.projectionId, entityKey]))
        if (scope.size === 0) state.activeSourceLinkScopes.delete(scopeKey)
      }
    }
  }
  for (const [rootKey, root] of candidate.roots) {
    root.active = !root.deleted
    root.retiredAt = root.deleted ? activation.updatedAt : null
    if (root.deleted) continue
    active.set(rootKey, candidate.materializationId)
    for (const entityKey of root.entityKeys) {
      // These are internal immutable assertions. Share their payload between indexes;
      // read methods clone returned values and transaction snapshots preserve aliases.
      const row = {
        source: candidate.source,
        materializationId: candidate.materializationId,
        ...candidate.rowsByEntity.get(entityKey)!,
      } as StoredSourceAssertion
      const indexKey = projectEntityKey(candidate.projectId, projectionEntityKey(row.assertion))
      const sources =
        state.activeSourceRows.get(indexKey) ?? new Map<string, StoredSourceAssertion>()
      sources.set(candidate.source.projectionId, row)
      state.activeSourceRows.set(indexKey, sources)
      if (row.assertion.kind === "link") {
        const scopeKey = projectEntityKey(
          candidate.projectId,
          linkScopeSortKey(row.assertion.ref.source, row.assertion.ref.linkId)
        )
        const scope =
          state.activeSourceLinkScopes.get(scopeKey) ?? new Map<string, StoredSourceLinkAssertion>()
        scope.set(
          JSON.stringify([candidate.source.projectionId, entityKey]),
          row as StoredSourceLinkAssertion
        )
        state.activeSourceLinkScopes.set(scopeKey, scope)
      }
    }
  }
  state.activeSourceRoots.set(sourceKey, active)
  state.activeSourceHeads.set(sourceKey, candidate.materializationId)
}
