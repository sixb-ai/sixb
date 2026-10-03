import { stableJsonStringify } from "../../json"
import {
  MaterializationConflictError,
  MaterializationValidationError,
} from "../../materialization/errors"
import { createEventId, materializationEventKindOrdinal } from "../../materialization/identity"
import type {
  EffectiveChangeCounts,
  OntologyLinkRef,
  OntologyObjectRef,
} from "../../materialization/model"
import {
  linkRefKey,
  linkRefSortKey,
  linkScopeSortKey,
  objectRefKey,
  projectionEntityKey,
  telemetryPointKey,
} from "../../materialization/refs"
import type { OntologyCommitWrite } from "./commits"
import {
  type ExactEffectiveLinkDelete,
  type ExactEffectiveLinkWrite,
  type ExactEffectiveObjectDelete,
  type ExactEffectiveObjectWrite,
  type ExactLinkOverrideDelete,
  type ExactLinkOverrideWrite,
  type ExactLinkSlotOverrideDelete,
  type ExactLinkSlotOverrideWrite,
  type ExactObjectOverrideDelete,
  type ExactObjectOverrideWrite,
  type ExactTimeseriesPointWrite,
  type MaterializationCardinalityOccupantWorkRecord,
  type MaterializationEventWorkRecord,
  type MaterializationPlanHeader,
  type MaterializationPlanWorkItem,
  type MaterializationPlanWorkRecord,
  type MaterializationWorkRecord,
  materializationApplyPhase,
} from "./materializations"
import type { OntologyMaterializationEventDraft, OntologyOutboxWrite } from "./outbox"
import { assertMaterializationHeader } from "./provider-header-validation"
import { assertTimestamp, invalidCorrelation } from "./provider-validation"
import type { PlannedReplacementIdentity, StageReplacementPlanInput } from "./replacement-plans"

export { invalidCorrelation } from "./provider-validation"

export function assertPageRows(value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new MaterializationValidationError("Materialization page size must be positive.")
}

export function materializationChunkRows(chunk: MaterializationPlanChunk): number {
  return (
    chunk.overrides.objects.upserts.length +
    chunk.overrides.objects.deletes.length +
    chunk.overrides.links.edges.upserts.length +
    chunk.overrides.links.edges.deletes.length +
    chunk.overrides.links.slots.upserts.length +
    chunk.overrides.links.slots.deletes.length +
    chunk.effective.objectUpserts.length +
    chunk.effective.objectDeletes.length +
    chunk.effective.linkUpserts.length +
    chunk.effective.linkDeletes.length +
    chunk.timeseries.pointUpserts.length +
    chunk.outbox.length
  )
}

export interface ExactOverrideWrites {
  readonly objects: {
    readonly upserts: readonly ExactObjectOverrideWrite[]
    readonly deletes: readonly ExactObjectOverrideDelete[]
  }
  readonly links: {
    readonly edges: {
      readonly upserts: readonly ExactLinkOverrideWrite[]
      readonly deletes: readonly ExactLinkOverrideDelete[]
    }
    readonly slots: {
      readonly upserts: readonly ExactLinkSlotOverrideWrite[]
      readonly deletes: readonly ExactLinkSlotOverrideDelete[]
    }
  }
}

export interface ExactEffectiveWrites {
  readonly objectUpserts: readonly ExactEffectiveObjectWrite[]
  readonly objectDeletes: readonly ExactEffectiveObjectDelete[]
  readonly linkUpserts: readonly ExactEffectiveLinkWrite[]
  readonly linkDeletes: readonly ExactEffectiveLinkDelete[]
}

export interface ExactTimeseriesWrites {
  readonly pointUpserts: readonly ExactTimeseriesPointWrite[]
}

/** Plan items and outbox writes of one bounded provider write, grouped by table. */
export interface MaterializationPlanChunk {
  readonly overrides: ExactOverrideWrites
  readonly effective: ExactEffectiveWrites
  readonly timeseries: ExactTimeseriesWrites
  readonly outbox: readonly OntologyOutboxWrite[]
}

/** Groups staged plan items, already in apply order, and outbox writes into one provider write. */
export function materializationPlanChunk(
  items: readonly MaterializationPlanWorkItem[],
  outbox: readonly OntologyOutboxWrite[] = []
): MaterializationPlanChunk {
  const chunk = {
    overrides: {
      objects: {
        upserts: [] as ExactObjectOverrideWrite[],
        deletes: [] as ExactObjectOverrideDelete[],
      },
      links: {
        edges: {
          upserts: [] as ExactLinkOverrideWrite[],
          deletes: [] as ExactLinkOverrideDelete[],
        },
        slots: {
          upserts: [] as ExactLinkSlotOverrideWrite[],
          deletes: [] as ExactLinkSlotOverrideDelete[],
        },
      },
    },
    effective: {
      objectUpserts: [] as ExactEffectiveObjectWrite[],
      objectDeletes: [] as ExactEffectiveObjectDelete[],
      linkUpserts: [] as ExactEffectiveLinkWrite[],
      linkDeletes: [] as ExactEffectiveLinkDelete[],
    },
    timeseries: { pointUpserts: [] as ExactTimeseriesPointWrite[] },
    outbox,
  }
  for (const item of items) {
    switch (item.kind) {
      case "object-override-upsert":
        chunk.overrides.objects.upserts.push(item.value)
        break
      case "object-override-delete":
        chunk.overrides.objects.deletes.push(item.value)
        break
      case "link-override-upsert":
        chunk.overrides.links.edges.upserts.push(item.value)
        break
      case "link-override-delete":
        chunk.overrides.links.edges.deletes.push(item.value)
        break
      case "link-slot-override-upsert":
        chunk.overrides.links.slots.upserts.push(item.value)
        break
      case "link-slot-override-delete":
        chunk.overrides.links.slots.deletes.push(item.value)
        break
      case "object-upsert":
        chunk.effective.objectUpserts.push(item.value)
        break
      case "object-delete":
        chunk.effective.objectDeletes.push(item.value)
        break
      case "link-upsert":
        chunk.effective.linkUpserts.push(item.value)
        break
      case "link-delete":
        chunk.effective.linkDeletes.push(item.value)
        break
      case "point-upsert":
        chunk.timeseries.pointUpserts.push(item.value)
        break
    }
  }
  return chunk
}

/** The outbox write of a staged event draft at its commit ordinal. */
export function materializationOutboxWrite(
  draft: OntologyMaterializationEventDraft,
  commitOrdinal: number
): OntologyOutboxWrite {
  return {
    envelope: {
      ...draft,
      id: createEventId(draft.projectId, draft.commitId, commitOrdinal),
      commitOrdinal,
    },
    availableAt: draft.occurredAt,
    createdAt: draft.occurredAt,
  }
}

/** One planned replacement identity, checked and summarized for a provider to store. */
export interface PreparedReplacementIdentity {
  readonly kind: "object" | "link"
  /** `objectRefKey` or `linkRefKey`, as classification records and provider tables key it. */
  readonly key: string
  readonly entityKey: string
  readonly records: readonly MaterializationWorkRecord[]
  readonly classified: boolean
  /** The effective change its work makes, null when it makes none. */
  readonly change: "created" | "updated" | "deleted" | null
}

/**
 * Validates the commit a replacement plan carries: once the plan is open, the very commit it was
 * opened with, time included.
 */
export function assertReplacementPlanCommit(
  commit: OntologyCommitWrite,
  opened?: { readonly commitId: string; readonly committedAt: string }
): void {
  assertMaterializationHeader({ commit, expected: NO_EXPECTATIONS })
  if (opened && (commit.id !== opened.commitId || commit.committedAt !== opened.committedAt)) {
    throw new MaterializationValidationError(
      "Replacement plan work must carry the commit its plan was opened with."
    )
  }
}

const NO_EXPECTATIONS = { sources: [], objects: [], links: [], linkScopes: [], points: [] }

/**
 * The identities of one `stage` call, checked against the commit the plan was opened with. Each is
 * planned once: one listed twice is rejected.
 */
export function prepareReplacementIdentities(
  input: Pick<StageReplacementPlanInput, "commit" | "planned">,
  opened: { readonly commitId: string; readonly committedAt: string }
): PreparedReplacementIdentity[] {
  assertReplacementPlanCommit(input.commit, opened)
  const header = { commit: input.commit, expected: NO_EXPECTATIONS }
  const keys = new Set<string>()
  return input.planned.map((planned) => {
    const prepared = prepareReplacementIdentity(planned, header)
    if (keys.has(prepared.entityKey)) {
      throw new MaterializationValidationError(
        `Replacement identity ${prepared.entityKey} is staged twice.`
      )
    }
    keys.add(prepared.entityKey)
    return prepared
  })
}

function prepareReplacementIdentity(
  planned: PlannedReplacementIdentity,
  header: MaterializationPlanHeader
): PreparedReplacementIdentity {
  const { identity } = planned
  const identityKind = identity.kind
  const key = identity.kind === "object" ? objectRefKey(identity.ref) : linkRefKey(identity.ref)
  const keys = new Set<string>()
  let classified = false
  let change: PreparedReplacementIdentity["change"] = null
  for (const record of planned.records) {
    assertWorkRecord(record, header)
    if (keys.has(record.recordKey)) {
      throw new MaterializationConflictError(
        "effective-state",
        `Duplicate materialization work key '${record.recordKey}'.`
      )
    }
    keys.add(record.recordKey)
    if (record.kind === "classification") {
      // Coverage is checked on the identity, so its classification must be its own.
      if (record.entityKind !== identityKind || record.identityKey !== key) {
        throw new MaterializationValidationError("A replacement identity can only classify itself.")
      }
      classified = true
    }
    if (record.kind !== "plan") continue
    const { item } = record
    if (item.kind === "object-upsert" || item.kind === "link-upsert") {
      change = item.value.expected.exists ? "updated" : "created"
    } else if (item.kind === "object-delete" || item.kind === "link-delete") {
      change = "deleted"
    }
  }
  return {
    kind: identityKind,
    key,
    entityKey: projectionEntityKey(identity),
    records: planned.records,
    classified,
    change,
  }
}

/** The change counts a replacement commit reports, derived from its planned work. */
export function projectionChangeCounts(
  records: Iterable<MaterializationWorkRecord>
): EffectiveChangeCounts {
  let objects = 0
  let links = 0
  const counts = {
    objectsCreated: 0,
    objectsUpdated: 0,
    objectsDeleted: 0,
    linksCreated: 0,
    linksUpdated: 0,
    linksDeleted: 0,
  }
  for (const record of records) {
    if (record.kind === "classification") {
      if (record.entityKind === "object") objects += 1
      if (record.entityKind === "link") links += 1
      continue
    }
    if (record.kind !== "plan") continue
    const { item } = record
    if (item.kind === "object-upsert") {
      if (item.value.expected.exists) counts.objectsUpdated += 1
      else counts.objectsCreated += 1
    } else if (item.kind === "object-delete") counts.objectsDeleted += 1
    else if (item.kind === "link-upsert") {
      if (item.value.expected.exists) counts.linksUpdated += 1
      else counts.linksCreated += 1
    } else if (item.kind === "link-delete") counts.linksDeleted += 1
  }
  return {
    ...counts,
    objectsUnchanged:
      objects - counts.objectsCreated - counts.objectsUpdated - counts.objectsDeleted,
    linksUnchanged: links - counts.linksCreated - counts.linksUpdated - counts.linksDeleted,
  }
}

export interface CardinalityValidator {
  /** Accepts staged cardinality records in canonical order (`compareCardinalityWork`). */
  accept(record: MaterializationCardinalityOccupantWorkRecord): void
}

/**
 * Rejects a cardinality-one scope with two occupants. The candidate view is the projection source
 * alone; the effective view is the resolved scope after this commit.
 */
export function createCardinalityValidator(): CardinalityValidator {
  let view: MaterializationCardinalityOccupantWorkRecord["view"] | null = null
  let scope: string | null = null
  let occupant: string | null = null
  return {
    accept(record) {
      if (record.view !== view || record.scopeSortKey !== scope) {
        view = record.view
        scope = record.scopeSortKey
        occupant = null
      }
      if (!record.occupied) return
      if (occupant !== null && occupant !== record.linkSortKey) {
        throw cardinalityViolation(record.view, record.ref.source.objectTypeId, record.ref.linkId)
      }
      occupant = record.linkSortKey
    },
  }
}

/** The user-facing error for a cardinality-one scope with two occupants. */
export function cardinalityViolation(
  view: MaterializationCardinalityOccupantWorkRecord["view"],
  sourceTypeId: string,
  linkId: string
): MaterializationValidationError {
  return new MaterializationValidationError(
    view === "candidate"
      ? `Projection source scope '${sourceTypeId}.${linkId}' has cardinality one.`
      : `Link scope '${sourceTypeId}.${linkId}' has cardinality one.`
  )
}

export function assertWorkRecord(
  record: MaterializationWorkRecord,
  header: MaterializationPlanHeader
): void {
  if (record.recordKey.trim().length === 0) {
    throw new MaterializationValidationError("Materialization work key must be nonblank.")
  }
  if (record.kind === "plan") {
    if (!/^[0-9a-f]+$/.test(record.sortKey) || !planPhaseMatches(record)) {
      throw new MaterializationValidationError("Materialization plan work has an invalid order.")
    }
    assertPlanItemCorrelation(record.item, header.commit)
    return
  }
  if (record.kind === "event") {
    if (
      !/^[0-9a-f]+$/.test(record.sortKey) ||
      !Number.isSafeInteger(record.eventKindRank) ||
      record.eventKindRank < 0 ||
      record.eventKindRank !== materializationEventKindOrdinal(record.draft.type) ||
      record.draft.projectId !== header.commit.projectId ||
      record.draft.commitId !== header.commit.id ||
      record.draft.occurredAt !== header.commit.committedAt ||
      stableJsonStringify(record.draft.origin) !== stableJsonStringify(header.commit.origin) ||
      !sameAttribution(record.draft, header.commit)
    ) {
      throw new MaterializationValidationError("Materialization event work is invalid.")
    }
    return
  }
  if (record.kind === "cardinality") {
    if (
      record.scopeSortKey !== linkScopeSortKey(record.ref.source, record.ref.linkId) ||
      record.linkSortKey !== linkRefSortKey(record.ref)
    ) {
      throw new MaterializationValidationError(
        "Materialization cardinality work has an invalid identity or order."
      )
    }
    return
  }
  if (record.kind === "classification" && record.identityKey.trim().length === 0) {
    throw new MaterializationValidationError("Materialization classification identity is invalid.")
  }
}

export function workUniquenessKey(record: MaterializationWorkRecord): string {
  switch (record.kind) {
    case "classification":
      return `classification:${record.entityKind}:${record.identityKey}`
    case "object-existence":
      return `object-existence:${objectRefKey(record.ref)}`
    case "incident-object":
      return `incident-object:${objectRefKey(record.ref)}`
    case "cardinality":
      return `cardinality:${record.view}:${record.scopeSortKey}:${record.linkSortKey}`
    case "plan":
      return `plan:${record.item.kind}:${record.sortKey}`
    case "event":
      return `event:${record.eventKindRank}:${record.sortKey}`
  }
}

export function comparePlanWork(
  left: MaterializationPlanWorkRecord,
  right: MaterializationPlanWorkRecord
): number {
  return (
    left.applyPhase - right.applyPhase ||
    materializationPlanKindRank(left.item.kind) - materializationPlanKindRank(right.item.kind) ||
    left.sortKey.localeCompare(right.sortKey) ||
    left.recordKey.localeCompare(right.recordKey)
  )
}

/** Canonical order of plan item kinds within an apply phase; providers store it with the work. */
export function materializationPlanKindRank(kind: MaterializationPlanWorkItem["kind"]): number {
  switch (kind) {
    case "object-override-upsert":
      return 0
    case "object-override-delete":
      return 1
    case "link-override-upsert":
      return 2
    case "link-override-delete":
      return 3
    case "link-slot-override-upsert":
      return 4
    case "link-slot-override-delete":
      return 5
    case "point-upsert":
      return 6
    case "link-delete":
      return 7
    case "object-delete":
      return 8
    case "object-upsert":
      return 9
    case "link-upsert":
      return 10
  }
}

export function compareCardinalityWork(
  left: MaterializationCardinalityOccupantWorkRecord,
  right: MaterializationCardinalityOccupantWorkRecord
): number {
  return (
    cardinalityViewOrder(left.view) - cardinalityViewOrder(right.view) ||
    left.scopeSortKey.localeCompare(right.scopeSortKey) ||
    left.linkSortKey.localeCompare(right.linkSortKey) ||
    left.recordKey.localeCompare(right.recordKey)
  )
}

function cardinalityViewOrder(view: MaterializationCardinalityOccupantWorkRecord["view"]): number {
  return view === "effective" ? 0 : 1
}

export function compareEventWork(
  left: MaterializationEventWorkRecord,
  right: MaterializationEventWorkRecord
): number {
  return (
    left.eventKindRank - right.eventKindRank ||
    left.sortKey.localeCompare(right.sortKey) ||
    left.recordKey.localeCompare(right.recordKey)
  )
}

function planPhaseMatches(record: MaterializationPlanWorkRecord): boolean {
  // Validate the submitted phase against the neutral contract's canonical mapping so a provider
  // still rejects a mis-ordered record without re-encoding the phase table here.
  return record.applyPhase === materializationApplyPhase(record.item.kind)
}

function assertPlanItemCorrelation(
  item: MaterializationPlanWorkItem,
  commit: MaterializationPlanHeader["commit"]
): void {
  switch (item.kind) {
    case "object-override-upsert":
      assertCommitWriteCorrelation(
        item.value.lastCommitId,
        item.value.updatedAt,
        commit,
        "Object override"
      )
      return
    case "object-override-delete":
      return
    case "link-override-upsert":
      assertCommitWriteCorrelation(
        item.value.lastCommitId,
        item.value.updatedAt,
        commit,
        "Link override"
      )
      return
    case "link-override-delete":
      return
    case "object-upsert":
      assertObjectRefEqual(item.value.row.ref, item.value.expected.ref, "Effective object upsert")
      assertCommitWriteCorrelation(
        item.value.row.lastCommitId,
        item.value.row.updatedAt,
        commit,
        "Effective object"
      )
      return
    case "object-delete":
      assertObjectRefEqual(item.value.ref, item.value.expected.ref, "Effective object delete")
      return
    case "link-upsert":
      assertLinkRefEqual(item.value.row.ref, item.value.expected.ref, "Effective link upsert")
      assertCommitWriteCorrelation(
        item.value.row.lastCommitId,
        item.value.row.updatedAt,
        commit,
        "Effective link"
      )
      return
    case "link-delete":
      assertLinkRefEqual(item.value.ref, item.value.expected.ref, "Effective link delete")
      return
    case "point-upsert":
      assertPointWriteCorrelation(item.value, commit)
      return
  }
}

function assertPointWriteCorrelation(
  value: ExactTimeseriesPointWrite,
  commit: MaterializationPlanHeader["commit"]
): void {
  if (
    telemetryPointKey(value.point.series, value.point.at) !==
    telemetryPointKey(value.expected.series, value.expected.at)
  ) {
    invalidCorrelation("Timeseries point write does not match its expected identity.")
  }
  assertTimestamp(value.point.at, "Timeseries point timestamp")
  if (value.point.lastCommitId !== commit.id) {
    invalidCorrelation("Timeseries point last commit id does not match its session commit.")
  }
}

function assertCommitWriteCorrelation(
  lastCommitId: string,
  updatedAt: string,
  commit: MaterializationPlanHeader["commit"],
  label: string
): void {
  if (lastCommitId !== commit.id || updatedAt !== commit.committedAt) {
    invalidCorrelation(`${label} provenance does not match its session commit.`)
  }
}

function assertObjectRefEqual(
  left: OntologyObjectRef,
  right: OntologyObjectRef,
  label: string
): void {
  if (objectRefKey(left) !== objectRefKey(right)) {
    invalidCorrelation(`${label} row and expected references differ.`)
  }
}

function assertLinkRefEqual(left: OntologyLinkRef, right: OntologyLinkRef, label: string): void {
  if (linkRefKey(left) !== linkRefKey(right)) {
    invalidCorrelation(`${label} row and expected references differ.`)
  }
}

/** Events carry exactly the attribution of the commit that produced them. */
function sameAttribution(
  event: Pick<OntologyCommitWrite, "requestedBy" | "executor">,
  commit: Pick<OntologyCommitWrite, "requestedBy" | "executor">
): boolean {
  return (
    stableJsonStringify(event.requestedBy ?? null) ===
      stableJsonStringify(commit.requestedBy ?? null) &&
    stableJsonStringify(event.executor) === stableJsonStringify(commit.executor)
  )
}
