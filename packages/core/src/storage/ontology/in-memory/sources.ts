import { stableJsonStringify } from "../../../json"
import {
  MaterializationConflictError,
  MaterializationValidationError,
} from "../../../materializer/errors"
import { projectionEntityKey } from "../../../materializer/refs"
import type {
  CleanupInactiveSourceGenerationsInput,
  DiscardSourceGenerationInput,
  GetActiveOntologySourceInput,
  OntologySourceRecord,
  OntologySourceStorage,
  StageSourceRowsInput,
  StageSourceRowsResult,
} from "../sources"
import {
  generationKey,
  type InMemoryOntologyState,
  type InMemorySourceGeneration,
  sourceKey,
} from "./shared-state"

export class InMemoryOntologySourceStorage implements OntologySourceStorage {
  constructor(
    private readonly state: InMemoryOntologyState,
    private readonly runRootOperation: <T>(run: () => Promise<T> | T) => Promise<T>
  ) {}

  async getActive(input: GetActiveOntologySourceInput): Promise<OntologySourceRecord | null> {
    return this.runRootOperation(() => {
      assertNonblank(input.projectId, "Source project id")
      assertNonblank(input.source.projectionId, "Source projection id")
      return structuredClone(
        this.state.activeSources.get(sourceKey(input.projectId, input.source.projectionId)) ?? null
      )
    })
  }

  async stage(input: StageSourceRowsInput): Promise<StageSourceRowsResult> {
    return this.runRootOperation(() => this.stageUnlocked(input))
  }

  private stageUnlocked(input: StageSourceRowsInput): StageSourceRowsResult {
    assertNonblank(input.projectId, "Source stage project id")
    assertNonblank(input.source.projectionId, "Source stage projection id")
    assertNonblank(input.generationId, "Source stage generation id")
    assertCanonicalTimestamp(input.stagedAt, "Source stagedAt")
    const key = generationKey(input.projectId, input.source.projectionId, input.generationId)
    const active = this.state.activeSources.get(
      sourceKey(input.projectId, input.source.projectionId)
    )
    if (active?.activeGenerationId === input.generationId) {
      throw new MaterializationConflictError(
        "source-generation",
        `Active source generation '${input.generationId}' cannot be staged.`
      )
    }
    const existingGeneration = this.state.generations.get(key)
    if (existingGeneration && existingGeneration.stagedAt !== input.stagedAt) {
      throw new MaterializationConflictError(
        "source-generation",
        `Source generation '${input.generationId}' was staged with a different fixed time.`
      )
    }
    const generation =
      existingGeneration ??
      ({
        projectId: input.projectId,
        sourceId: input.source.projectionId,
        generationId: input.generationId,
        stagedAt: input.stagedAt,
        rowsByEntity: new Map(),
        rootOrdinals: new Map(),
      } as const)

    let inserted = 0
    let unchanged = 0
    const newRows = new Map<string, StageSourceRowsInput["rows"][number]>()
    const newRootOrdinals = new Map<string, number>()
    for (const row of input.rows) {
      assertEntityIds(row.root, "Source root")
      assertEntityIds(row.assertion, "Source assertion")
      if (!Number.isSafeInteger(row.stagingOrdinal) || row.stagingOrdinal < 0) {
        throw new MaterializationValidationError(
          "Source staging ordinal must be a nonnegative safe integer."
        )
      }
      const rootKey = projectionEntityKey(row.root)
      const existingOrdinal = generation.rootOrdinals.get(rootKey) ?? newRootOrdinals.get(rootKey)
      if (existingOrdinal !== undefined && existingOrdinal !== row.stagingOrdinal) {
        throw new MaterializationValidationError(
          `Projection generation repeats root ${rootKey} at a different stream ordinal.`
        )
      }

      const entityKey = projectionEntityKey(row.assertion)
      const existing = generation.rowsByEntity.get(entityKey) ?? newRows.get(entityKey)
      if (existing) {
        if (stableJsonStringify(existing) === stableJsonStringify(row)) {
          unchanged += 1
          continue
        }
        throw new MaterializationValidationError(
          `Projection generation repeats asserted entity ${entityKey}.`
        )
      }

      newRootOrdinals.set(rootKey, row.stagingOrdinal)
      newRows.set(entityKey, structuredClone(row))
      inserted += 1
    }
    for (const [rootKey, ordinal] of newRootOrdinals) {
      generation.rootOrdinals.set(rootKey, ordinal)
    }
    for (const [entityKey, row] of newRows) generation.rowsByEntity.set(entityKey, row)
    this.state.generations.set(key, generation)
    return { inserted, unchanged }
  }

  async discard(input: DiscardSourceGenerationInput): Promise<void> {
    await this.runRootOperation(() => this.discardUnlocked(input))
  }

  private discardUnlocked(input: DiscardSourceGenerationInput): void {
    assertNonblank(input.projectId, "Source discard project id")
    assertNonblank(input.source.projectionId, "Source discard projection id")
    assertNonblank(input.generationId, "Source discard generation id")
    const active = this.state.activeSources.get(
      sourceKey(input.projectId, input.source.projectionId)
    )
    if (active?.activeGenerationId === input.generationId) {
      throw new MaterializationConflictError(
        "source-generation",
        `Active source generation '${input.generationId}' cannot be discarded.`
      )
    }
    this.state.generations.delete(
      generationKey(input.projectId, input.source.projectionId, input.generationId)
    )
  }

  async cleanupInactive(input: CleanupInactiveSourceGenerationsInput): Promise<number> {
    return this.runRootOperation(() => this.cleanupInactiveUnlocked(input))
  }

  private cleanupInactiveUnlocked(input: CleanupInactiveSourceGenerationsInput): number {
    assertNonblank(input.projectId, "Inactive source cleanup project id")
    const cutoff = Date.parse(input.olderThan)
    if (!Number.isFinite(cutoff) || !Number.isSafeInteger(input.limit) || input.limit <= 0) {
      throw new MaterializationValidationError(
        "Inactive source cleanup requires a valid timestamp and positive limit."
      )
    }
    const candidates: [string, InMemorySourceGeneration][] = []
    for (const entry of this.state.generations.entries()) {
      const [, generation] = entry
      if (generation.projectId !== input.projectId || Date.parse(generation.stagedAt) >= cutoff) {
        continue
      }
      const active = this.state.activeSources.get(sourceKey(input.projectId, generation.sourceId))
      if (active?.activeGenerationId === generation.generationId) continue
      insertBounded(candidates, entry, input.limit, compareGenerationEntries)
    }
    for (const [key] of candidates) this.state.generations.delete(key)
    return candidates.length
  }
}

function compareGenerationEntries(
  [, left]: readonly [string, { stagedAt: string; sourceId: string; generationId: string }],
  [, right]: readonly [string, { stagedAt: string; sourceId: string; generationId: string }]
): number {
  return (
    left.stagedAt.localeCompare(right.stagedAt) ||
    left.sourceId.localeCompare(right.sourceId) ||
    left.generationId.localeCompare(right.generationId)
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
