import { stableJsonStringify } from "../../../json"
import {
  MaterializationConflictError,
  MaterializationValidationError,
} from "../../../materialization/errors"
import { projectionEntityKey } from "../../../materialization/refs"
import type {
  AbandonSourceMaterializationCandidateInput,
  AbandonSourceMaterializationInput,
  AssertSourceMaterializationExecution,
  BeginSourceMaterializationInput,
  CleanupTerminalSourceMaterializationsInput,
  CleanupTerminalSourceMaterializationsResult,
  GetActiveOntologySourceInput,
  MarkSourceMaterializationReadyInput,
  OntologySourceRecord,
  OntologySourceStorage,
  ReclaimSourceMaterializationInput,
  SourceMaterializationExecution,
  StageSourceAssertion,
  StageSourceRowsInput,
  StageSourceRowsResult,
} from "../sources"
import {
  type InMemoryOntologyState,
  type InMemorySourceMaterialization,
  sourceMaterializationKey,
  sourceMaterializationRecord,
} from "./shared-state"

export class InMemoryOntologySourceStorage implements OntologySourceStorage {
  constructor(
    private readonly state: InMemoryOntologyState,
    private readonly runRootOperation: <T>(run: () => Promise<T> | T) => Promise<T>,
    private readonly assertExecution: AssertSourceMaterializationExecution
  ) {}

  async beginMaterialization(
    input: BeginSourceMaterializationInput
  ): Promise<OntologySourceRecord> {
    return this.runRootOperation(async () => {
      assertBeginInput(input)
      await this.assertCurrentExecution(input)
      const key = sourceMaterializationKey(
        input.projectId,
        input.source.projectionId,
        input.materializationId
      )
      const existing = this.state.sourceMaterializations.get(key)
      if (existing) {
        if (isExactStagingManifest(existing, input)) return sourceMaterializationRecord(existing)
        throw sourceConflict(
          `Source materialization '${input.materializationId}' already exists with different identity or state.`
        )
      }

      const nonterminal = this.findRunCandidates(
        input.projectId,
        input.source.projectionId,
        input.execution.projectionRunId
      )
      if (nonterminal.length > 0) {
        throw sourceConflict(
          `Projection run '${input.execution.projectionRunId}' already has a nonterminal source materialization; reclaim it before beginning another.`
        )
      }

      const materialization: InMemorySourceMaterialization = {
        projectId: input.projectId,
        source: structuredClone(input.source),
        materializationId: input.materializationId,
        projectionRunId: input.execution.projectionRunId,
        projectionKind: input.projectionKind,
        protocol: input.protocol,
        status: "staging",
        executionToken: input.execution.executionToken,
        datasetVersion: structuredClone(input.datasetVersion),
        projectionRevision: input.projectionRevision,
        ownershipHash: input.ownershipHash,
        ontologyRevision: input.ontologyRevision,
        rootCount: null,
        assertionCount: null,
        createdAt: input.createdAt,
        readyAt: null,
        activatedAt: null,
        terminalAt: null,
        lastCommitId: null,
        updatedAt: input.createdAt,
        rowsByEntity: new Map(),
        rootOrdinals: new Map(),
        ordinalRoots: new Map(),
      }
      this.state.sourceMaterializations.set(key, materialization)
      return sourceMaterializationRecord(materialization)
    })
  }

  async stageRows(input: StageSourceRowsInput): Promise<StageSourceRowsResult> {
    return this.runRootOperation(async () => {
      assertWriteIdentity(input)
      await this.assertCurrentExecution(input)
      const materialization = this.requireMaterialization(input)
      assertCandidateOwner(materialization, input.execution)
      if (materialization.status !== "staging") {
        throw sourceConflict(
          `Source materialization '${input.materializationId}' is '${materialization.status}' and cannot accept rows.`
        )
      }
      return stageRowsAtomically(materialization, input.rows)
    })
  }

  async markReady(input: MarkSourceMaterializationReadyInput): Promise<OntologySourceRecord> {
    return this.runRootOperation(async () => {
      assertWriteIdentity(input)
      assertCanonicalTimestamp(input.readyAt, "Source readyAt")
      assertCount(input.rootCount, "Source root count")
      assertCount(input.assertionCount, "Source assertion count")
      await this.assertCurrentExecution(input)
      const materialization = this.requireMaterialization(input)
      assertCandidateOwner(materialization, input.execution)

      if (materialization.status === "ready") {
        if (
          materialization.rootCount === input.rootCount &&
          materialization.assertionCount === input.assertionCount &&
          materialization.readyAt === input.readyAt
        ) {
          return sourceMaterializationRecord(materialization)
        }
        throw sourceConflict(
          `Source materialization '${input.materializationId}' was marked ready with different counts or time.`
        )
      }
      if (materialization.status !== "staging") {
        throw sourceConflict(
          `Source materialization '${input.materializationId}' cannot transition from '${materialization.status}' to 'ready'.`
        )
      }
      assertNotBefore(input.readyAt, materialization.createdAt, "Source readyAt", "createdAt")
      assertReadyCounts(materialization, input.rootCount, input.assertionCount)

      const ready: InMemorySourceMaterialization = {
        ...materialization,
        status: "ready",
        rootCount: input.rootCount,
        assertionCount: input.assertionCount,
        readyAt: input.readyAt,
        updatedAt: input.readyAt,
      }
      this.state.sourceMaterializations.set(
        sourceMaterializationKey(
          input.projectId,
          input.source.projectionId,
          input.materializationId
        ),
        ready
      )
      return sourceMaterializationRecord(ready)
    })
  }

  async getActive(input: GetActiveOntologySourceInput): Promise<OntologySourceRecord | null> {
    return this.runRootOperation(() => {
      assertProjectAndSource(input)
      const active = [...this.state.sourceMaterializations.values()].filter(
        (materialization) =>
          materialization.projectId === input.projectId &&
          materialization.source.projectionId === input.source.projectionId &&
          materialization.status === "active"
      )
      if (active.length > 1) {
        throw sourceConflict(
          `Source '${input.source.projectionId}' has more than one active materialization.`
        )
      }
      return active[0] ? sourceMaterializationRecord(active[0]) : null
    })
  }

  async abandon(input: AbandonSourceMaterializationCandidateInput): Promise<OntologySourceRecord>
  async abandon(input: ReclaimSourceMaterializationInput): Promise<OntologySourceRecord | null>
  async abandon(input: AbandonSourceMaterializationInput): Promise<OntologySourceRecord | null> {
    return this.runRootOperation(async () => {
      assertProjectAndSource(input)
      assertExecution(input.execution)
      assertCanonicalTimestamp(input.abandonedAt, "Source abandonedAt")
      await this.assertCurrentExecution(input)
      return input.kind === "candidate"
        ? this.abandonCandidate(input)
        : this.abandonForReclaim(input)
    })
  }

  async cleanupTerminal(
    input: CleanupTerminalSourceMaterializationsInput
  ): Promise<CleanupTerminalSourceMaterializationsResult> {
    return this.runRootOperation(() => {
      assertNonblank(input.projectId, "Terminal source cleanup project id")
      assertCanonicalTimestamp(input.terminalBefore, "Terminal source cleanup cutoff")
      if (!Number.isSafeInteger(input.limit) || input.limit <= 0) {
        throw new MaterializationValidationError(
          "Terminal source cleanup limit must be a positive safe integer."
        )
      }

      const candidates: [string, InMemorySourceMaterialization][] = []
      for (const entry of this.state.sourceMaterializations.entries()) {
        const materialization = entry[1]
        if (
          materialization.projectId !== input.projectId ||
          (materialization.status !== "superseded" && materialization.status !== "abandoned") ||
          materialization.terminalAt === null ||
          materialization.terminalAt >= input.terminalBefore
        ) {
          continue
        }
        insertBounded(candidates, entry, input.limit, compareTerminalMaterializations)
      }

      let remaining = input.limit
      let rowsDeleted = 0
      let materializationsDeleted = 0
      for (const [key, candidate] of candidates) {
        if (remaining === 0) break
        const current = this.state.sourceMaterializations.get(key)
        if (current !== candidate) continue
        // Terminal manifests never participate in reads or activation again. Release their
        // ingestion-only indexes immediately instead of retaining O(root count) memory until the
        // last child row is removed by a later bounded cleanup pass.
        current.rootOrdinals.clear()
        current.ordinalRoots.clear()
        for (const entityKey of current.rowsByEntity.keys()) {
          if (remaining === 0) break
          current.rowsByEntity.delete(entityKey)
          rowsDeleted += 1
          remaining -= 1
        }
        if (current.rowsByEntity.size === 0 && remaining > 0) {
          this.state.sourceMaterializations.delete(key)
          materializationsDeleted += 1
          remaining -= 1
        }
      }
      return { rowsDeleted, materializationsDeleted }
    })
  }

  private async assertCurrentExecution(input: {
    readonly projectId: string
    readonly source: BeginSourceMaterializationInput["source"]
    readonly execution: SourceMaterializationExecution
  }): Promise<void> {
    await this.assertExecution({
      projectId: input.projectId,
      source: input.source,
      execution: input.execution,
    })
  }

  private requireMaterialization(input: {
    readonly projectId: string
    readonly source: BeginSourceMaterializationInput["source"]
    readonly materializationId: string
  }): InMemorySourceMaterialization {
    const materialization = this.state.sourceMaterializations.get(
      sourceMaterializationKey(input.projectId, input.source.projectionId, input.materializationId)
    )
    if (!materialization) {
      throw sourceConflict(`Source materialization '${input.materializationId}' does not exist.`)
    }
    return materialization
  }

  private abandonCandidate(
    input: AbandonSourceMaterializationCandidateInput
  ): OntologySourceRecord {
    const materialization = this.requireMaterialization(input)
    if (materialization.status === "abandoned") {
      if (
        materialization.projectionRunId === input.execution.projectionRunId &&
        materialization.terminalAt === input.abandonedAt
      ) {
        return sourceMaterializationRecord(materialization)
      }
      throw sourceConflict(
        `Source materialization '${input.materializationId}' was abandoned by another execution or at another time.`
      )
    }
    assertCandidateOwner(materialization, input.execution)
    if (materialization.status !== "staging" && materialization.status !== "ready") {
      throw sourceConflict(
        `Source materialization '${input.materializationId}' cannot transition from '${materialization.status}' to 'abandoned'.`
      )
    }
    return this.transitionToAbandoned(materialization, input.abandonedAt)
  }

  private abandonForReclaim(input: ReclaimSourceMaterializationInput): OntologySourceRecord | null {
    const candidates = this.findRunCandidates(
      input.projectId,
      input.source.projectionId,
      input.execution.projectionRunId
    )
    if (
      candidates.some(
        ([, materialization]) => materialization.executionToken === input.execution.executionToken
      )
    ) {
      throw sourceConflict(
        `Projection run '${input.execution.projectionRunId}' already has a source materialization owned by the current execution.`
      )
    }
    if (candidates.length > 1) {
      throw sourceConflict(
        `Projection run '${input.execution.projectionRunId}' has multiple nonterminal source materializations.`
      )
    }
    const candidate = candidates[0]?.[1]
    return candidate ? this.transitionToAbandoned(candidate, input.abandonedAt) : null
  }

  private transitionToAbandoned(
    materialization: InMemorySourceMaterialization,
    abandonedAt: string
  ): OntologySourceRecord {
    assertNotBefore(abandonedAt, materialization.createdAt, "Source abandonedAt", "createdAt")
    if (materialization.readyAt !== null) {
      assertNotBefore(abandonedAt, materialization.readyAt, "Source abandonedAt", "readyAt")
    }
    const abandoned: InMemorySourceMaterialization = {
      ...materialization,
      status: "abandoned",
      executionToken: null,
      terminalAt: abandonedAt,
      updatedAt: abandonedAt,
    }
    this.state.sourceMaterializations.set(
      sourceMaterializationKey(
        materialization.projectId,
        materialization.source.projectionId,
        materialization.materializationId
      ),
      abandoned
    )
    return sourceMaterializationRecord(abandoned)
  }

  private findRunCandidates(
    projectId: string,
    sourceId: string,
    projectionRunId: string
  ): [string, InMemorySourceMaterialization][] {
    return [...this.state.sourceMaterializations.entries()].filter(
      ([, materialization]) =>
        materialization.projectId === projectId &&
        materialization.source.projectionId === sourceId &&
        materialization.projectionRunId === projectionRunId &&
        (materialization.status === "staging" || materialization.status === "ready")
    )
  }
}

function stageRowsAtomically(
  materialization: InMemorySourceMaterialization,
  rows: StageSourceRowsInput["rows"]
): StageSourceRowsResult {
  let inserted = 0
  let unchanged = 0
  const newRows = new Map<string, StageSourceRowsInput["rows"][number]>()
  const newRootOrdinals = new Map<string, number>()
  const newOrdinalRoots = new Map<number, string>()
  for (const row of rows) {
    assertRowMatchesProjectionKind(materialization, row)
    assertEntityIds(row.root, "Source root")
    assertEntityIds(row.assertion, "Source assertion")
    if (!Number.isSafeInteger(row.stagingOrdinal) || row.stagingOrdinal < 0) {
      throw new MaterializationValidationError(
        "Source staging ordinal must be a nonnegative safe integer."
      )
    }

    const rootKey = projectionEntityKey(row.root)
    const existingOrdinal =
      materialization.rootOrdinals.get(rootKey) ?? newRootOrdinals.get(rootKey)
    if (existingOrdinal !== undefined && existingOrdinal !== row.stagingOrdinal) {
      throw new MaterializationValidationError(
        `Source materialization repeats root ${rootKey} at a different stream ordinal.`
      )
    }
    const existingRoot =
      materialization.ordinalRoots.get(row.stagingOrdinal) ??
      newOrdinalRoots.get(row.stagingOrdinal)
    if (existingRoot !== undefined && existingRoot !== rootKey) {
      throw new MaterializationValidationError(
        `Source materialization repeats stream ordinal ${row.stagingOrdinal} for another root.`
      )
    }

    const entityKey = projectionEntityKey(row.assertion)
    const existing = materialization.rowsByEntity.get(entityKey) ?? newRows.get(entityKey)
    if (existing) {
      if (stableJsonStringify(existing) === stableJsonStringify(row)) {
        unchanged += 1
        continue
      }
      throw new MaterializationValidationError(
        `Source materialization repeats asserted entity ${entityKey}.`
      )
    }

    newRootOrdinals.set(rootKey, row.stagingOrdinal)
    newOrdinalRoots.set(row.stagingOrdinal, rootKey)
    newRows.set(entityKey, structuredClone(row))
    inserted += 1
  }

  for (const [rootKey, ordinal] of newRootOrdinals) {
    materialization.rootOrdinals.set(rootKey, ordinal)
  }
  for (const [ordinal, rootKey] of newOrdinalRoots) {
    materialization.ordinalRoots.set(ordinal, rootKey)
  }
  for (const [entityKey, row] of newRows) materialization.rowsByEntity.set(entityKey, row)
  return { inserted, unchanged }
}

function assertReadyCounts(
  materialization: InMemorySourceMaterialization,
  rootCount: number,
  assertionCount: number
): void {
  if (
    materialization.rootOrdinals.size !== rootCount ||
    materialization.ordinalRoots.size !== rootCount ||
    materialization.rowsByEntity.size !== assertionCount
  ) {
    throw new MaterializationValidationError(
      "Source ready counts do not match the staged roots and assertions."
    )
  }
  for (let ordinal = 0; ordinal < rootCount; ordinal += 1) {
    if (!materialization.ordinalRoots.has(ordinal)) {
      throw new MaterializationValidationError(
        `Source staging ordinals must be contiguous from zero; missing ${ordinal}.`
      )
    }
  }
  assertReadyTopology(materialization)
}

function assertReadyTopology(materialization: InMemorySourceMaterialization): void {
  const rowsByRoot = new Map<string, StageSourceAssertion[]>()
  for (const row of materialization.rowsByEntity.values()) {
    const rootKey = projectionEntityKey(row.root)
    const rows = rowsByRoot.get(rootKey) ?? []
    rows.push(row)
    rowsByRoot.set(rootKey, rows)
  }

  for (const rootKey of materialization.rootOrdinals.keys()) {
    const rows = rowsByRoot.get(rootKey) ?? []
    const first = rows[0]
    if (!first) {
      throw new MaterializationValidationError(`Source root ${rootKey} has no staged assertions.`)
    }
    const root = first.root

    if (materialization.projectionKind === "link") {
      if (
        rows.length !== 1 ||
        root.kind !== "link" ||
        first.assertion.kind !== "link" ||
        projectionEntityKey(first.assertion) !== rootKey
      ) {
        throw new MaterializationValidationError(
          `Link projection root ${rootKey} must contain exactly its matching link assertion.`
        )
      }
      continue
    }

    if (root.kind !== "object") {
      throw new MaterializationValidationError(
        `Object projection root ${rootKey} must be an object.`
      )
    }
    const matchingObjects = rows.filter(
      (row) => row.assertion.kind === "object" && projectionEntityKey(row.assertion) === rootKey
    )
    const hasForeignAssertion = rows.some((row) => {
      if (row.assertion.kind === "object") return projectionEntityKey(row.assertion) !== rootKey
      return projectionEntityKey({ kind: "object", ref: row.assertion.ref.source }) !== rootKey
    })
    if (matchingObjects.length !== 1 || hasForeignAssertion) {
      throw new MaterializationValidationError(
        `Object projection root ${rootKey} must contain exactly its matching object assertion plus links sourced from that root.`
      )
    }
  }
}

function isExactStagingManifest(
  existing: InMemorySourceMaterialization,
  input: BeginSourceMaterializationInput
): boolean {
  return (
    existing.status === "staging" &&
    existing.executionToken === input.execution.executionToken &&
    existing.projectionRunId === input.execution.projectionRunId &&
    existing.projectionKind === input.projectionKind &&
    existing.protocol === input.protocol &&
    existing.createdAt === input.createdAt &&
    existing.projectionRevision === input.projectionRevision &&
    existing.ownershipHash === input.ownershipHash &&
    existing.ontologyRevision === input.ontologyRevision &&
    stableJsonStringify(existing.datasetVersion) === stableJsonStringify(input.datasetVersion)
  )
}

function assertBeginInput(input: BeginSourceMaterializationInput): void {
  assertWriteIdentity(input)
  if (input.projectionKind !== "object" && input.projectionKind !== "link") {
    throw new MaterializationValidationError("Source projection kind must be 'object' or 'link'.")
  }
  if (input.protocol !== "replacement") {
    throw new MaterializationValidationError(
      "Source materialization protocol must be 'replacement'."
    )
  }
  assertNonblank(input.projectionRevision, "Source projection revision")
  assertNonblank(input.ownershipHash, "Source ownership hash")
  assertNonblank(input.ontologyRevision, "Source ontology revision")
  assertNonblank(input.datasetVersion.datasetId, "Source dataset id")
  assertNonblank(input.datasetVersion.versionId, "Source dataset version id")
  assertCanonicalTimestamp(input.datasetVersion.createdAt, "Source dataset version createdAt")
  assertCanonicalTimestamp(input.createdAt, "Source createdAt")
}

function assertRowMatchesProjectionKind(
  materialization: InMemorySourceMaterialization,
  row: StageSourceRowsInput["rows"][number]
): void {
  if (materialization.projectionKind === "object") {
    if (row.root.kind !== "object") {
      throw new MaterializationValidationError(
        "Object projection source rows require an object root."
      )
    }
    return
  }
  if (row.root.kind !== "link" || row.assertion.kind !== "link") {
    throw new MaterializationValidationError(
      "Link projection source rows require a link root and link assertion."
    )
  }
}

function assertWriteIdentity(input: {
  readonly projectId: string
  readonly source: BeginSourceMaterializationInput["source"]
  readonly materializationId: string
  readonly execution: SourceMaterializationExecution
}): void {
  assertProjectAndSource(input)
  assertNonblank(input.materializationId, "Source materialization id")
  assertExecution(input.execution)
}

function assertProjectAndSource(input: {
  readonly projectId: string
  readonly source: BeginSourceMaterializationInput["source"]
}): void {
  assertNonblank(input.projectId, "Source project id")
  assertNonblank(input.source.projectionId, "Source projection id")
}

function assertExecution(execution: SourceMaterializationExecution): void {
  assertNonblank(execution.projectionRunId, "Source projection run id")
  assertNonblank(execution.executionToken, "Source execution token")
}

function assertCandidateOwner(
  materialization: InMemorySourceMaterialization,
  execution: SourceMaterializationExecution
): void {
  if (
    materialization.projectionRunId !== execution.projectionRunId ||
    materialization.executionToken !== execution.executionToken
  ) {
    throw sourceConflict(
      `Source materialization '${materialization.materializationId}' is owned by another execution.`
    )
  }
}

function assertCount(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new MaterializationValidationError(`${label} must be a nonnegative safe integer.`)
  }
}

function assertNonblank(value: string, label: string): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new MaterializationValidationError(`${label} must be nonblank.`)
  }
}

function assertCanonicalTimestamp(value: string, label: string): void {
  const milliseconds = Date.parse(value)
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    throw new MaterializationValidationError(`${label} must be a canonical UTC timestamp.`)
  }
}

function assertNotBefore(
  value: string,
  minimum: string,
  label: string,
  minimumLabel: string
): void {
  if (value < minimum) {
    throw new MaterializationValidationError(`${label} cannot precede source ${minimumLabel}.`)
  }
}

function assertEntityIds(
  entity:
    | StageSourceRowsInput["rows"][number]["root"]
    | StageSourceRowsInput["rows"][number]["assertion"],
  label: string
): void {
  if (entity.kind === "object") {
    assertNonblank(entity.ref.objectTypeId, `${label} object type id`)
    assertNonblank(entity.ref.primaryId, `${label} primary id`)
    return
  }
  assertNonblank(entity.ref.source.objectTypeId, `${label} source object type id`)
  assertNonblank(entity.ref.source.primaryId, `${label} source primary id`)
  assertNonblank(entity.ref.linkId, `${label} link id`)
  assertNonblank(entity.ref.target.objectTypeId, `${label} target object type id`)
  assertNonblank(entity.ref.target.primaryId, `${label} target primary id`)
}

function compareTerminalMaterializations(
  [, left]: readonly [string, InMemorySourceMaterialization],
  [, right]: readonly [string, InMemorySourceMaterialization]
): number {
  return (
    (left.terminalAt ?? "").localeCompare(right.terminalAt ?? "") ||
    left.source.projectionId.localeCompare(right.source.projectionId) ||
    left.materializationId.localeCompare(right.materializationId)
  )
}

function insertBounded<T>(
  values: T[],
  value: T,
  limit: number,
  compare: (left: T, right: T) => number
): void {
  let index = values.findIndex((candidate) => compare(value, candidate) < 0)
  if (index < 0) index = values.length
  values.splice(index, 0, value)
  if (values.length > limit) values.pop()
}

function sourceConflict(message: string): MaterializationConflictError {
  return new MaterializationConflictError("source-materialization", message)
}
