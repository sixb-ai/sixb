import { stableJsonStringify } from "../../../json"
import {
  MaterializationConflictError,
  MaterializationValidationError,
} from "../../../materialization/errors"
import type {
  OntologyLinkRef,
  OntologyObjectRef,
  ProjectionEntityRef,
} from "../../../materialization/model"
import {
  linkRefKey,
  linkRefSortKey,
  linkScopeKey,
  linkScopeSortKey,
  objectRefKey,
  objectRefSortKey,
  projectionEntityKey,
} from "../../../materialization/refs"
import {
  getInMemoryObjectMaterializerAdapter,
  type InMemoryObjectStorage,
} from "../../objects/in-memory"
import type {
  MaterializationObjectExistence,
  MaterializationWorkRecord,
  SourceReplacementLinkState,
  SourceReplacementObjectState,
} from "../materializations"
import { assertPageRows, duplicateMaterializationWork } from "../provider"
import { assertNonblank, assertPositiveInteger } from "../provider-validation"
import {
  assertReplacementPlanCommit,
  prepareReplacementIdentities,
  projectionChangeCounts,
  workUniquenessKey,
} from "../provider-work"
import type {
  OntologyReplacementPlanStorage,
  OpenedReplacementPlan,
  OpenReplacementPlanInput,
  PurgeReplacementPlansInput,
  ReplacementPlanRef,
  ReplacementPlanStatePage,
  ReplacementPlanStatus,
  StageReplacementPlanInput,
  StreamReplacementPlanStateInput,
} from "../replacement-plans"
import type { AssertSourceMaterializationExecution } from "../sources"
import {
  findActiveSourceMaterialization,
  linkRef,
  storedSourceLink,
  storedSourceObject,
} from "./materializations-state"
import {
  type InMemoryOntologyState,
  type InMemoryOntologyStorageTestHooks,
  type InMemorySourceMaterialization,
  projectEntityKey,
  sourceMaterializationKey,
} from "./shared-state"
import { previousSourceRows } from "./source-roots"
import type { InMemoryMaterializationStateReader } from "./state-reader"

export interface InMemoryPlanIdentity {
  readonly entity: ProjectionEntityRef
  readonly sortKey: string
  diffRequired: boolean
  /** Revision of the inputs the identity's state was last read at. */
  readRevision: string | null
  /** Revision its records were planned from; null while it is still to plan. */
  plannedRevision: string | null
  records: readonly MaterializationWorkRecord[]
}

export interface InMemoryReplacementPlan {
  readonly projectId: string
  readonly sourceId: string
  readonly materializationId: string
  readonly projectionKind: "object" | "link"
  /** The commit the plan's work carries, and its time fixed when the plan opened. */
  readonly commitId: string
  readonly committedAt: string
  /** The active source the plan replaces, null when none was active. */
  readonly replacedMaterializationId: string | null
  readonly replacedLastCommitId: string | null
  /** Commits finalized when every planned identity was last known fresh. */
  watermark: number
  /** Entities this replacement decides: its own rows and those of the roots it replaces. */
  readonly owned: Set<string>
  /** Keyed by `projectionEntityKey`. */
  readonly identities: Map<string, InMemoryPlanIdentity>
  /** Record and uniqueness keys of the planned work, each unique within the plan. */
  readonly workKeys: Set<string>
}

export function replacementPlanKey(input: {
  readonly projectId: string
  readonly source: { readonly projectionId: string }
  readonly materializationId: string
}): string {
  return sourceMaterializationKey(
    input.projectId,
    input.source.projectionId,
    input.materializationId
  )
}

export class InMemoryOntologyReplacementPlanStorage implements OntologyReplacementPlanStorage {
  constructor(
    private readonly state: InMemoryOntologyState,
    private readonly objects: InMemoryObjectStorage,
    private readonly reader: InMemoryMaterializationStateReader,
    private readonly runRootOperation: <T>(run: () => Promise<T> | T) => Promise<T>,
    private readonly assertExecution: AssertSourceMaterializationExecution,
    private readonly hooks: InMemoryOntologyStorageTestHooks = {}
  ) {}

  async open(input: OpenReplacementPlanInput): Promise<OpenedReplacementPlan> {
    return this.runRootOperation(async () => {
      assertReplacementPlanCommit(input.commit)
      const candidate = await this.requireCandidate(input)
      const key = replacementPlanKey(input)
      const active = findActiveSourceMaterialization(
        this.state,
        input.projectId,
        input.source.projectionId
      )
      const replacedMaterializationId = active?.materializationId ?? null
      const replacedLastCommitId = active?.lastCommitId ?? null
      const existing = this.state.replacementPlans.get(key)
      // A plan decides the entities of the source it replaces: once that moved, it starts over.
      if (
        existing?.replacedMaterializationId === replacedMaterializationId &&
        existing.replacedLastCommitId === replacedLastCommitId
      ) {
        return { committedAt: existing.committedAt }
      }
      const plan: InMemoryReplacementPlan = {
        projectId: input.projectId,
        sourceId: input.source.projectionId,
        materializationId: input.materializationId,
        projectionKind: candidate.projectionKind,
        commitId: input.commit.id,
        committedAt: input.commit.committedAt,
        replacedMaterializationId,
        replacedLastCommitId,
        watermark: this.state.commitsById.size,
        owned: new Set(),
        identities: new Map(),
        workKeys: new Set(),
      }
      for (const rows of [
        previousSourceRows(this.state, candidate),
        candidate.rowsByEntity.values(),
      ]) {
        for (const row of rows) {
          plan.owned.add(projectionEntityKey(row.assertion))
          addIdentity(plan, row.assertion, true)
        }
      }
      this.state.replacementPlans.set(key, plan)
      return { committedAt: plan.committedAt }
    })
  }

  async *streamState(
    input: StreamReplacementPlanStateInput
  ): AsyncIterable<ReplacementPlanStatePage> {
    assertPageRows(input.pageRows)
    this.hooks.beforeRead?.(`replacement-plan.${input.entityKind}`)
    const pending = await this.runRootOperation(async () => {
      const { plan } = await this.requirePlan(input)
      if (input.entityKind === "object" && plan.projectionKind !== "object") {
        throw new MaterializationConflictError(
          "source-materialization",
          "Link projection replacement cannot stream object state."
        )
      }
      if (input.entityKind === "link") {
        if (unplanned(plan, "object").length > 0) {
          throw new MaterializationConflictError(
            "effective-state",
            "Object projection replacement must plan every object before its links."
          )
        }
        this.expandLinks(plan)
      }
      return unplanned(plan, input.entityKind).map((identity) =>
        projectionEntityKey(identity.entity)
      )
    })
    for (let offset = 0; offset < pending.length; offset += input.pageRows) {
      const keys = pending.slice(offset, offset + input.pageRows)
      const page = await this.runRootOperation(async () => {
        const { plan, candidate } = await this.requirePlan(input)
        // Looked up again: a rolled back transaction restores the plan as copies.
        const selected = keys.flatMap((key) => {
          const identity = plan.identities.get(key)
          return identity?.plannedRevision === null ? [identity] : []
        })
        if (selected.length === 0) return null
        return input.entityKind === "object"
          ? this.objectPage(plan, candidate, selected)
          : this.linkPage(plan, candidate, selected)
      })
      if (!page) continue
      this.hooks.observeBuffer?.(
        `replacement.${input.entityKind}.page`,
        page.objects.length + page.links.length
      )
      yield page
    }
  }

  async stage(input: StageReplacementPlanInput): Promise<void> {
    await this.runRootOperation(async () => {
      const { plan } = await this.requirePlan(input)
      // Only an identity streamed and still to plan has the revision its work is planned from,
      // and holds no work: unplanning one deletes its work and forgets what it read.
      const updates = prepareReplacementIdentities(input, plan).map((prepared) => {
        const current = plan.identities.get(prepared.entityKey)
        if (!current || current.readRevision === null || current.plannedRevision !== null) {
          throw new MaterializationValidationError(
            `Replacement identity ${prepared.entityKey} is not streamed and still to plan.`
          )
        }
        return { current, records: structuredClone(prepared.records) }
      })
      const claimed = new Set<string>()
      for (const { records } of updates) {
        for (const record of records) {
          for (const key of workKeys(record)) {
            if (claimed.has(key) || plan.workKeys.has(key)) {
              throw duplicateMaterializationWork(record.recordKey)
            }
            claimed.add(key)
          }
        }
      }
      const staged = updates.flatMap(({ records }) => records)
      this.hooks.observeWork?.(staged)
      for (const { current, records } of updates) {
        current.records = records
        current.plannedRevision = current.readRevision
      }
      for (const key of claimed) plan.workKeys.add(key)
      this.hooks.observeBuffer?.("plan.stage", updates.length)
    })
  }

  async refresh(input: ReplacementPlanRef): Promise<ReplacementPlanStatus> {
    const { plan } = await this.requirePlan(input)
    const pending = [...plan.identities.values()].filter(
      (identity) => identity.plannedRevision === null
    )
    if (pending.length > 0) return { fresh: false, unplanned: pending.length }
    let unplannedCount = 0
    if (this.state.commitsById.size !== plan.watermark) {
      for (const identity of plan.identities.values()) {
        if (this.revision(plan, identity) === identity.plannedRevision) continue
        unplan(plan, identity)
        unplannedCount += 1
      }
      unplannedCount += this.expandLinks(plan)
      plan.watermark = this.state.commitsById.size
    }
    if (unplannedCount > 0) return { fresh: false, unplanned: unplannedCount }
    return {
      fresh: true,
      counts: projectionChangeCounts(
        [...plan.identities.values()].flatMap((identity) => identity.records)
      ),
    }
  }

  async purge(input: PurgeReplacementPlansInput): Promise<number> {
    assertNonblank(input.projectId, "Replacement plan purge project id")
    assertPositiveInteger(input.limit, "Replacement plan purge limit")
    // Commits and abandons delete their plan at once: in memory there is nothing to batch.
    return 0
  }

  private async objectPage(
    plan: InMemoryReplacementPlan,
    candidate: InMemorySourceMaterialization,
    selected: readonly InMemoryPlanIdentity[]
  ): Promise<ReplacementPlanStatePage> {
    const objects: SourceReplacementObjectState[] = []
    for (const identity of selected) {
      const ref = identity.entity.ref as OntologyObjectRef
      const base = await this.reader.objectState(plan.projectId, ref)
      objects.push({
        ref: base.ref,
        candidateSource: storedSourceObject(
          plan.sourceId,
          plan.materializationId,
          candidate.rowsByEntity.get(projectionEntityKey(identity.entity))
        ),
        override: base.override,
        effective: base.effective,
        latestTelemetry: base.latestTelemetry,
      })
      identity.readRevision = this.revision(plan, identity)
    }
    return { objects, links: [], endpoints: [] }
  }

  private async linkPage(
    plan: InMemoryReplacementPlan,
    candidate: InMemorySourceMaterialization,
    selected: readonly InMemoryPlanIdentity[]
  ): Promise<ReplacementPlanStatePage> {
    const links: SourceReplacementLinkState[] = []
    const endpoints = new Map<string, MaterializationObjectExistence>()
    for (const identity of selected) {
      const ref = identity.entity.ref as OntologyLinkRef
      const key = projectionEntityKey(identity.entity)
      const base = await this.reader.linkState(plan.projectId, ref)
      links.push({
        ref: base.ref,
        candidateSource: plan.owned.has(key)
          ? storedSourceLink(plan.sourceId, plan.materializationId, candidate.rowsByEntity.get(key))
          : base.source,
        override: base.override,
        slotOverride: base.slotOverride,
        effective: base.effective,
        diffRequired: identity.diffRequired,
      })
      for (const endpoint of [ref.source, ref.target]) {
        endpoints.set(objectRefKey(endpoint), {
          ref: structuredClone(endpoint),
          exists: this.endpointExists(plan, endpoint),
        })
      }
      identity.readRevision = this.revision(plan, identity)
    }
    return { objects: [], links, endpoints: [...endpoints.values()] }
  }

  /** An endpoint exists as this plan leaves it when the plan decides it, else as effective. */
  private endpointExists(plan: InMemoryReplacementPlan, ref: OntologyObjectRef): boolean {
    const planned = plan.identities.get(projectionEntityKey({ kind: "object", ref }))
    const existence = planned?.records.find((record) => record.kind === "object-existence")
    if (existence?.kind === "object-existence") return existence.exists
    return (
      getInMemoryObjectMaterializerAdapter(this.objects).getExactObjectRow(
        plan.projectId,
        ref.objectTypeId,
        ref.primaryId
      ) !== null
    )
  }

  /**
   * The revision of everything an identity's plan reads. An object reads its effective row, its
   * override and its latest telemetry; a link reads its effective row, its edge and slot
   * overrides, the live source asserting it when this replacement does not, and the existence of
   * both endpoints: as planned for an object of this plan, which follows its whole revision, and
   * as it is for any other.
   */
  private revision(plan: InMemoryReplacementPlan, identity: InMemoryPlanIdentity): string {
    if (identity.entity.kind === "object") {
      return stableJsonStringify(this.objectRevision(plan.projectId, identity.entity.ref))
    }
    const ref = identity.entity.ref
    const projectId = plan.projectId
    const row = getInMemoryObjectMaterializerAdapter(this.objects).getExactLinkRow(projectId, {
      sourceTypeId: ref.source.objectTypeId,
      sourceId: ref.source.primaryId,
      linkId: ref.linkId,
      targetTypeId: ref.target.objectTypeId,
      targetId: ref.target.primaryId,
    })
    const live = this.reader.findActiveLinkSource(projectId, ref)
    return stableJsonStringify([
      row?.lastCommitId ?? null,
      this.state.linkOverrides.get(projectEntityKey(projectId, linkRefKey(ref)))?.lastCommitId ??
        null,
      this.state.linkSlotOverrides.get(
        projectEntityKey(projectId, linkScopeKey(ref.source, ref.linkId))
      )?.lastCommitId ?? null,
      live ? [live.source.projectionId, live.materializationId, live.stagingOrdinal] : null,
      this.endpointRevision(plan, ref.source),
      this.endpointRevision(plan, ref.target),
    ])
  }

  private endpointRevision(plan: InMemoryReplacementPlan, ref: OntologyObjectRef): unknown {
    if (plan.identities.has(projectionEntityKey({ kind: "object", ref }))) {
      return this.objectRevision(plan.projectId, ref)
    }
    return (
      getInMemoryObjectMaterializerAdapter(this.objects).getExactObjectRow(
        plan.projectId,
        ref.objectTypeId,
        ref.primaryId
      ) !== null
    )
  }

  private objectRevision(projectId: string, ref: OntologyObjectRef): unknown {
    const row = getInMemoryObjectMaterializerAdapter(this.objects).getExactObjectRow(
      projectId,
      ref.objectTypeId,
      ref.primaryId
    )
    return [
      row ? [row.version, row.lastCommitId] : null,
      this.state.objectOverrides.get(projectEntityKey(projectId, objectRefKey(ref)))
        ?.lastCommitId ?? null,
      this.reader
        .latestTelemetry(projectId, ref)
        .map((point) => [point.series.propertyId, point.at, point.lastCommitId]),
    ]
  }

  /**
   * Adds the links a plan must decide besides its own: those incident to an object whose
   * existence it flips, and every member of a scope it changes. Returns how many identities this
   * left to plan, counting an existing one that now needs a diff.
   */
  private expandLinks(plan: InMemoryReplacementPlan): number {
    const projectId = plan.projectId
    const incident = new Set<string>()
    for (const identity of plan.identities.values()) {
      for (const record of identity.records) {
        if (record.kind === "incident-object") incident.add(objectRefKey(record.ref))
      }
    }
    let added = 0
    const consider = (ref: OntologyLinkRef, diffRequired: boolean): void => {
      if (addIdentity(plan, { kind: "link", ref }, diffRequired)) added += 1
    }
    if (incident.size > 0) {
      const index = this.reader.incidentLinkIndex(projectId)
      for (const key of incident) {
        for (const ref of index.get(key) ?? []) consider(ref, true)
      }
    }
    const adapter = getInMemoryObjectMaterializerAdapter(this.objects)
    const scopes = new Map<string, Pick<OntologyLinkRef, "source" | "linkId">>()
    for (const identity of plan.identities.values()) {
      if (identity.entity.kind !== "link" || !identity.diffRequired) continue
      const ref = identity.entity.ref
      scopes.set(linkScopeSortKey(ref.source, ref.linkId), ref)
    }
    for (const scope of scopes.values()) {
      adapter.visitExactScopeLinks(
        projectId,
        scope.source.objectTypeId,
        scope.source.primaryId,
        scope.linkId,
        (row) => consider(linkRef(row), false)
      )
      const override = this.state.linkSlotOverrides.get(
        projectEntityKey(projectId, linkScopeKey(scope.source, scope.linkId))
      )
      if (override) consider({ ...scope, target: override.value.target }, false)
    }
    return added
  }

  private async requireCandidate(
    input: ReplacementPlanRef
  ): Promise<InMemorySourceMaterialization> {
    const candidate = this.state.sourceMaterializations.get(replacementPlanKey(input))
    if (
      !candidate ||
      candidate.status !== "ready" ||
      candidate.projectionRunId !== input.execution.projectionRunId ||
      candidate.executionToken !== input.execution.executionToken
    ) {
      throw new MaterializationConflictError(
        "source-materialization",
        `Candidate source materialization '${input.materializationId}' is missing, not ready, or owned by another execution.`
      )
    }
    await this.assertExecution({
      projectId: input.projectId,
      source: input.source,
      execution: input.execution,
    })
    return candidate
  }

  private async requirePlan(
    input: ReplacementPlanRef
  ): Promise<{ plan: InMemoryReplacementPlan; candidate: InMemorySourceMaterialization }> {
    const candidate = await this.requireCandidate(input)
    const plan = this.state.replacementPlans.get(replacementPlanKey(input))
    if (!plan) {
      throw new MaterializationConflictError(
        "source-materialization",
        `Candidate source materialization '${input.materializationId}' has no open plan.`
      )
    }
    return { plan, candidate }
  }
}

/** Adds an identity, or makes an existing one need a diff. True when it left one to plan. */
function addIdentity(
  plan: InMemoryReplacementPlan,
  entity: ProjectionEntityRef,
  diffRequired: boolean
): boolean {
  const key = projectionEntityKey(entity)
  const existing = plan.identities.get(key)
  if (existing) {
    if (!diffRequired || existing.diffRequired) return false
    existing.diffRequired = true
    unplan(plan, existing)
    return true
  }
  plan.identities.set(key, {
    entity: structuredClone({ kind: entity.kind, ref: entity.ref } as ProjectionEntityRef),
    sortKey: entity.kind === "object" ? objectRefSortKey(entity.ref) : linkRefSortKey(entity.ref),
    diffRequired,
    readRevision: null,
    plannedRevision: null,
    records: [],
  })
  return true
}

function unplan(plan: InMemoryReplacementPlan, identity: InMemoryPlanIdentity): void {
  for (const record of identity.records) {
    for (const key of workKeys(record)) plan.workKeys.delete(key)
  }
  identity.readRevision = null
  identity.plannedRevision = null
  identity.records = []
}

function workKeys(record: MaterializationWorkRecord): readonly string[] {
  return [`record:${record.recordKey}`, `unique:${workUniquenessKey(record)}`]
}

function unplanned(plan: InMemoryReplacementPlan, kind: "object" | "link"): InMemoryPlanIdentity[] {
  return [...plan.identities.values()]
    .filter((identity) => identity.entity.kind === kind && identity.plannedRevision === null)
    .sort((left, right) => left.sortKey.localeCompare(right.sortKey))
}
