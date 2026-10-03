import {
  MaterializationConflictError,
  MaterializationValidationError,
} from "../../../materialization/errors"
import type {
  ExpectedLinkRevision,
  ExpectedObjectRevision,
  OntologyLinkRef,
  OntologyObjectRef,
} from "../../../materialization/model"
import {
  linkRefKey,
  linkRefSortKey,
  linkScopeKey,
  linkScopeSortKey,
  objectRefKey,
  objectRefSortKey,
  telemetryPointKey,
  telemetryPointSortKey,
} from "../../../materialization/refs"
import {
  getInMemoryObjectMaterializerAdapter,
  type InMemoryObjectStorage,
} from "../../objects/in-memory"
import {
  getInMemoryTimeseriesMaterializerAdapter,
  type InMemoryTimeseriesStorage,
} from "../../timeseries/store"
import type { OntologyCommitRecord } from "../commits"
import type {
  AppliedMaterialization,
  ApplyMaterializationInput,
  ApplyMaterializationResult,
  ExpectedSourceRevision,
  ExpectedTimeseriesPointRevision,
  FinalizeMaterializationInput,
  MaterializationCardinalityOccupantWorkRecord,
  MaterializationEventWorkRecord,
  MaterializationLinkScopeRevision,
  MaterializationLinkScopeState,
  MaterializationLinkState,
  MaterializationObjectState,
  MaterializationPlanHeader,
  MaterializationPlanWorkRecord,
  MaterializationSession,
  MaterializationStatePage,
  MaterializationVectorChange,
  MaterializationVectorChangePage,
  MaterializationWorkRecord,
  OntologyMaterializationStorage,
  StageMaterializationWorkInput,
  StoredTelemetryPoint,
  StreamMaterializationStateInput,
  StreamMaterializationVectorChangesInput,
} from "../materializations"
import type { OntologyMaterializationEvent } from "../outbox"
import {
  assertExpectedLinkRevision,
  assertExpectedLinkScopeRevision,
  assertExpectedObjectRevision,
  assertMaterializationHeader,
  beginMaterializationApply,
  beginMaterializationVectorChanges,
  duplicateMaterializationWork,
  type ProviderMaterializationTransactionLifecycle,
  prepareMaterializationWork,
  uniqueSorted,
} from "../provider"
import { assertFinalizationCorrelations } from "./materializations-finalization"
import { findActiveSourceMaterialization, storedPoint, uniqueBy } from "./materializations-state"
import {
  assertLastCommit,
  assertPageRows,
  compareCardinalityWork,
  compareEventWork,
  comparePlanWork,
  createCardinalityValidator,
  invalidCorrelation,
  type MaterializationPlanChunk,
  materializationChunkRows,
  materializationOutboxWrite,
  materializationPlanChunk,
  workUniquenessKey,
} from "./materializations-work"
import { type InMemoryReplacementPlan, replacementPlanKey } from "./replacement-plans"
import {
  assertTimestamp,
  commitKey,
  commitOriginKey,
  type InMemoryOntologyState,
  type InMemoryOntologyStorageTestHooks,
  idempotencyKey,
  ontologyCommitOriginSelector,
  outboxKey,
  projectEntityKey,
  sourceMaterializationKey,
} from "./shared-state"
import { activateSourceRoots } from "./source-roots"
import type { InMemoryMaterializationStateReader } from "./state-reader"
import { vectorObjectKey } from "./vectors"

export interface SessionState {
  readonly providerToken: object
  readonly header: MaterializationPlanHeader
  readonly transactionToken: object
  readonly lifecycle: ProviderMaterializationTransactionLifecycle
  active: boolean
  writeOrdinal: number
  readonly work: Map<string, MaterializationWorkRecord>
  readonly workUniqueKeys: Set<string>
  readonly applyWork: MaterializationPlanWorkRecord[]
  readonly cardinalityWork: MaterializationCardinalityOccupantWorkRecord[]
  readonly eventWork: MaterializationEventWorkRecord[]
  readonly outboxEnvelopes: Map<number, OntologyMaterializationEvent>
  workSealed: boolean
  vectorChangesStreamed: boolean
  applied: boolean
  appliedEventCount: number
  incidentLinksByObject: Map<string, readonly OntologyLinkRef[]> | null
  linkSlotStates: Map<string, MaterializationLinkScopeState> | null
  /** The durable replacement plan this session applies instead of staged work. */
  readonly plan: InMemoryReplacementPlan | null
}

export class InMemoryOntologyMaterializationStorage implements OntologyMaterializationStorage {
  private readonly sessions = new WeakMap<object, SessionState>()
  private readonly liveSessions = new Set<SessionState>()

  constructor(
    private readonly state: InMemoryOntologyState,
    private readonly objects: InMemoryObjectStorage,
    private readonly timeseries: InMemoryTimeseriesStorage,
    private readonly reader: InMemoryMaterializationStateReader,
    private readonly getTransactionToken: () => object | null,
    private readonly getMaterializationLifecycle: () => ProviderMaterializationTransactionLifecycle | null,
    private readonly executionExists: (projectId: string, executionId: string) => Promise<boolean>,
    private readonly hooks: InMemoryOntologyStorageTestHooks = {}
  ) {}

  async begin(input: MaterializationPlanHeader): Promise<MaterializationSession> {
    const transactionToken = this.getTransactionToken()
    const lifecycle = this.getMaterializationLifecycle()
    if (!transactionToken || !lifecycle) {
      throw new MaterializationValidationError(
        "Materialization sessions require an active storage transaction."
      )
    }
    assertMaterializationHeader(input)
    if (!(await this.executionExists(input.commit.projectId, input.commit.executionId))) {
      throw new MaterializationValidationError(
        `Ontology commit execution '${input.commit.executionId}' does not exist in project '${input.commit.projectId}'.`
      )
    }
    this.assertCommitAbsent(input)
    for (const expected of input.expected.sources)
      this.assertSource(expected, input.commit.projectId)
    for (const expected of input.expected.objects)
      await this.assertObject(expected, input.commit.projectId)
    for (const expected of input.expected.links)
      await this.assertLink(expected, input.commit.projectId)
    const expectedScopeRevisions = new Map<string, MaterializationLinkScopeRevision>()
    for (const expected of input.expected.linkScopes) {
      const key = linkScopeSortKey(expected.source, expected.linkId)
      const current =
        expectedScopeRevisions.get(key) ??
        this.reader.effectiveLinkScope(input.commit.projectId, expected.source, expected.linkId)
      expectedScopeRevisions.set(key, current)
      assertExpectedLinkScopeRevision(current.fingerprint, expected)
    }
    for (const expected of input.expected.points) this.assertPoint(expected, input.commit.projectId)
    const plan = input.plan ? this.requirePlan(input) : null

    const providerToken = {}
    const session = {
      providerToken,
      header: structuredClone(input),
      transactionToken,
      lifecycle,
      active: true,
      writeOrdinal: 0,
      work: new Map<string, MaterializationWorkRecord>(),
      workUniqueKeys: new Set<string>(),
      applyWork: [],
      cardinalityWork: [],
      eventWork: [],
      outboxEnvelopes: new Map<number, OntologyMaterializationEvent>(),
      workSealed: false,
      vectorChangesStreamed: false,
      applied: false,
      appliedEventCount: 0,
      incidentLinksByObject: null,
      linkSlotStates: new Map(),
      plan,
    }
    if (plan) {
      for (const identity of plan.identities.values()) {
        for (const record of structuredClone(identity.records)) this.addWork(session, record)
      }
    }
    this.sessions.set(providerToken, session)
    this.liveSessions.add(session)
    lifecycle.register(providerToken)
    return { providerToken }
  }

  deactivateTransaction(transactionToken: object): void {
    for (const session of this.liveSessions) {
      if (session.transactionToken !== transactionToken) continue
      this.releaseSession(session)
    }
  }

  /** Deactivate a session, drop its transaction-local work, and stop tracking it as live. */
  private releaseSession(session: SessionState): void {
    session.active = false
    session.work.clear()
    session.workUniqueKeys.clear()
    session.applyWork.length = 0
    session.cardinalityWork.length = 0
    session.eventWork.length = 0
    session.outboxEnvelopes.clear()
    session.incidentLinksByObject = null
    session.linkSlotStates = null
    this.liveSessions.delete(session)
    session.lifecycle.complete(session.providerToken)
  }

  async *streamState(
    input: StreamMaterializationStateInput
  ): AsyncIterable<MaterializationStatePage> {
    const session = this.requireSession(input.session)
    assertPageRows(input.pageRows)
    for await (const request of input.requests) {
      this.requireSession(input.session)
      this.hooks.beforeRead?.("state.read")
      const objectRefs = uniqueSorted(request.objects, objectRefKey, objectRefSortKey)
      for (let offset = 0; offset < objectRefs.length; offset += input.pageRows) {
        this.requireSession(input.session)
        const objects: MaterializationObjectState[] = []
        for (const ref of objectRefs.slice(offset, offset + input.pageRows)) {
          objects.push(await this.reader.objectState(session.header.commit.projectId, ref))
        }
        this.requireSession(input.session)
        this.hooks.observeBuffer?.("state.object.page", objects.length)
        yield { objects, links: [], linkScopes: [], points: [] }
      }

      const linkRefs = uniqueSorted(request.links, linkRefKey, linkRefSortKey)
      for (let offset = 0; offset < linkRefs.length; offset += input.pageRows) {
        this.requireSession(input.session)
        const links: MaterializationLinkState[] = []
        for (const ref of linkRefs.slice(offset, offset + input.pageRows)) {
          links.push(await this.reader.linkState(session.header.commit.projectId, ref))
        }
        this.requireSession(input.session)
        this.hooks.observeBuffer?.("state.link.page", links.length)
        yield { objects: [], links, linkScopes: [], points: [] }
      }

      const incidentRefs = this.incidentLinkRefs(session, request.incidentObjects)
      for (let offset = 0; offset < incidentRefs.length; offset += input.pageRows) {
        this.requireSession(input.session)
        const refs = incidentRefs.slice(offset, offset + input.pageRows)
        const links: MaterializationLinkState[] = []
        for (const ref of refs)
          links.push(await this.reader.linkState(session.header.commit.projectId, ref))
        this.requireSession(input.session)
        this.hooks.observeBuffer?.("state.incident-link.page", links.length)
        yield { objects: [], links, linkScopes: [], points: [] }
      }

      for (const scope of uniqueBy(request.linkScopes, (value) =>
        linkScopeSortKey(value.source, value.linkId)
      )) {
        this.requireSession(input.session)
        const value = this.linkSlotState(session, scope.source, scope.linkId)
        // Scope rows are currently only requested for cardinality-one links, so the complete member
        // set is bounded by the ontology invariant. Replacement scope enumeration is flattened in
        // its dedicated stream and never uses this shape.
        yield { objects: [], links: [], linkScopes: [value], points: [] }
      }

      const requestedPoints = uniqueSorted(
        request.points,
        (point) => telemetryPointKey(point.series, point.at),
        (point) => telemetryPointSortKey(point.series, point.at)
      )
      for (let offset = 0; offset < requestedPoints.length; offset += input.pageRows) {
        this.requireSession(input.session)
        const points: StoredTelemetryPoint[] = []
        for (const point of requestedPoints.slice(offset, offset + input.pageRows)) {
          const stored = getInMemoryTimeseriesMaterializerAdapter(this.timeseries).getExactPoint(
            session.header.commit.projectId,
            point.series,
            point.at
          )
          if (stored) points.push(storedPoint(stored))
        }
        this.requireSession(input.session)
        this.hooks.observeBuffer?.("state.point.page", points.length)
        if (points.length > 0) yield { objects: [], links: [], linkScopes: [], points }
      }
    }
  }

  async stageWork(input: StageMaterializationWorkInput): Promise<void> {
    const session = this.requireSession(input.session)
    for (const { record, uniqueKey } of prepareMaterializationWork(session, input)) {
      if (session.work.has(record.recordKey) || session.workUniqueKeys.has(uniqueKey)) {
        throw duplicateMaterializationWork(record.recordKey)
      }
    }
    const cloned = input.records.map((record) => structuredClone(record))
    this.hooks.observeWork?.(cloned)
    for (const record of cloned) this.addWork(session, record)
    this.hooks.observeBuffer?.("work.stage", cloned.length)
  }

  private addWork(session: SessionState, record: MaterializationWorkRecord): void {
    session.work.set(record.recordKey, record)
    session.workUniqueKeys.add(workUniquenessKey(record))
    if (record.kind === "plan") session.applyWork.push(record)
    if (record.kind === "cardinality") session.cardinalityWork.push(record)
    if (record.kind === "event") session.eventWork.push(record)
  }

  async *streamVectorChanges(
    input: StreamMaterializationVectorChangesInput
  ): AsyncIterable<MaterializationVectorChangePage> {
    const session = this.requireSession(input.session)
    assertPageRows(input.pageRows)
    this.sealWork(session, beginMaterializationVectorChanges)
    const projectId = session.header.commit.projectId
    const profiled = new Set(input.objectTypeIds)
    const changes = session.applyWork.flatMap((record): MaterializationVectorChange[] => {
      const item = record.item
      if (item.kind !== "object-upsert" && item.kind !== "object-delete") return []
      const ref = item.kind === "object-upsert" ? item.value.row.ref : item.value.ref
      return profiled.has(ref.objectTypeId) ||
        (this.state.vectors.get(vectorObjectKey(projectId, ref))?.size ?? 0) > 0
        ? [item]
        : []
    })
    for (let offset = 0; offset < changes.length; offset += input.pageRows) {
      this.requireSession(input.session)
      yield { items: structuredClone(changes.slice(offset, offset + input.pageRows)) }
    }
    this.requireSession(input.session)
  }

  async apply(input: ApplyMaterializationInput): Promise<AppliedMaterialization> {
    const session = this.requireSession(input.session)
    this.sealWork(session, beginMaterializationApply)
    const cardinality = createCardinalityValidator()
    for (const record of session.cardinalityWork) cardinality.accept(record)
    for (let start = 0; start < session.applyWork.length; ) {
      const phase = session.applyWork[start]!.applyPhase
      let end = start
      while (session.applyWork[end]?.applyPhase === phase) end += 1
      const items = session.applyWork.slice(start, end).map((record) => record.item)
      this.writeChunk(session, materializationPlanChunk(items))
      start = end
    }
    const outbox = session.eventWork.map((record, ordinal) =>
      materializationOutboxWrite(record.draft, ordinal)
    )
    this.writeChunk(session, materializationPlanChunk([], outbox))
    session.appliedEventCount = outbox.length
    return { eventCount: outbox.length }
  }

  private writeChunk(session: SessionState, chunk: MaterializationPlanChunk): void {
    const projectId = session.header.commit.projectId
    this.hooks.observeBuffer?.("apply.chunk", materializationChunkRows(chunk))
    const write = (boundary: string, apply: () => void): void => {
      this.hooks.beforeWrite?.(boundary, session.writeOrdinal++)
      apply()
    }

    for (const item of chunk.overrides.objects.upserts)
      write("override.object.upsert", () => {
        const key = projectEntityKey(projectId, objectRefKey(item.ref))
        assertLastCommit(
          this.state.objectOverrides.get(key),
          item.expectedLastCommitId,
          "object override"
        )
        this.state.objectOverrides.set(
          key,
          structuredClone({
            projectId,
            ref: item.ref,
            value: item.value,
            editedAt: { ...item.editedAt },
            lastCommitId: item.lastCommitId,
            updatedAt: item.updatedAt,
          })
        )
      })
    for (const item of chunk.overrides.objects.deletes)
      write("override.object.delete", () => {
        const key = projectEntityKey(projectId, objectRefKey(item.ref))
        assertLastCommit(
          this.state.objectOverrides.get(key),
          item.expectedLastCommitId,
          "object override"
        )
        this.state.objectOverrides.delete(key)
      })
    for (const item of chunk.overrides.links.edges.upserts)
      write("override.link.upsert", () => {
        const key = projectEntityKey(projectId, linkRefKey(item.ref))
        assertLastCommit(
          this.state.linkOverrides.get(key),
          item.expectedLastCommitId,
          "link edge override"
        )
        this.state.linkOverrides.set(
          key,
          structuredClone({
            projectId,
            ref: item.ref,
            value: item.value,
            lastCommitId: item.lastCommitId,
            updatedAt: item.updatedAt,
          })
        )
      })
    for (const item of chunk.overrides.links.edges.deletes)
      write("override.link.delete", () => {
        const key = projectEntityKey(projectId, linkRefKey(item.ref))
        assertLastCommit(
          this.state.linkOverrides.get(key),
          item.expectedLastCommitId,
          "link edge override"
        )
        this.state.linkOverrides.delete(key)
      })
    for (const item of chunk.overrides.links.slots.upserts)
      write("override.link-slot.upsert", () => {
        const key = projectEntityKey(projectId, linkScopeKey(item.ref.source, item.ref.linkId))
        assertLastCommit(
          this.state.linkSlotOverrides.get(key),
          item.expectedLastCommitId,
          "link slot override"
        )
        this.state.linkSlotOverrides.set(
          key,
          structuredClone({
            projectId,
            ref: item.ref,
            value: item.value,
            lastCommitId: item.lastCommitId,
            updatedAt: item.updatedAt,
          })
        )
      })
    for (const item of chunk.overrides.links.slots.deletes)
      write("override.link-slot.delete", () => {
        const key = projectEntityKey(projectId, linkScopeKey(item.ref.source, item.ref.linkId))
        assertLastCommit(
          this.state.linkSlotOverrides.get(key),
          item.expectedLastCommitId,
          "link slot override"
        )
        this.state.linkSlotOverrides.delete(key)
      })

    for (const item of chunk.effective.linkDeletes)
      write("effective.link.delete", () => {
        this.assertLinkSync(item.expected, projectId)
        getInMemoryObjectMaterializerAdapter(this.objects).deleteExactLink({
          projectId,
          sourceTypeId: item.ref.source.objectTypeId,
          sourceId: item.ref.source.primaryId,
          linkId: item.ref.linkId,
          targetTypeId: item.ref.target.objectTypeId,
          targetId: item.ref.target.primaryId,
        })
      })
    for (const item of chunk.effective.objectDeletes)
      write("effective.object.delete", () => {
        this.assertObjectSync(item.expected, projectId)
        getInMemoryObjectMaterializerAdapter(this.objects).deleteExactObject(
          projectId,
          item.ref.objectTypeId,
          item.ref.primaryId
        )
      })
    for (const item of chunk.effective.objectUpserts)
      write("effective.object.upsert", () => {
        this.assertObjectSync(item.expected, projectId)
        getInMemoryObjectMaterializerAdapter(this.objects).applyExactObject(item.row, projectId)
      })
    for (const item of chunk.effective.linkUpserts)
      write("effective.link.upsert", () => {
        this.assertLinkSync(item.expected, projectId)
        getInMemoryObjectMaterializerAdapter(this.objects).applyExactLink(item.row, projectId)
      })
    for (const item of chunk.timeseries.pointUpserts)
      write("timeseries.point.upsert", () => {
        this.assertPoint(item.expected, projectId)
        getInMemoryTimeseriesMaterializerAdapter(this.timeseries).applyExactPoint(
          projectId,
          item.point
        )
      })
    for (const item of chunk.outbox)
      write("outbox.insert", () => {
        const envelope = item.envelope
        if (envelope.projectId !== projectId || envelope.commitId !== session.header.commit.id) {
          throw new MaterializationValidationError(
            "Outbox event does not correlate with its materialization commit."
          )
        }
        assertTimestamp(item.availableAt, "Outbox availableAt")
        assertTimestamp(item.createdAt, "Outbox createdAt")
        assertTimestamp(envelope.occurredAt, "Outbox event occurredAt")
        const key = outboxKey(projectId, envelope.id)
        if (this.state.outbox.has(key)) {
          throw new MaterializationConflictError(
            "effective-state",
            `Duplicate outbox event '${envelope.id}'.`
          )
        }
        if (session.outboxEnvelopes.has(envelope.commitOrdinal))
          throw new MaterializationConflictError(
            "effective-state",
            "Duplicate outbox commit ordinal."
          )
        this.state.outbox.set(key, {
          envelope: structuredClone(envelope),
          availableAt: item.availableAt,
          attempts: 0,
          leaseId: null,
          leaseExpiresAt: null,
          publishedAt: null,
          lastFailure: null,
          createdAt: item.createdAt,
        })
        session.outboxEnvelopes.set(envelope.commitOrdinal, structuredClone(envelope))
      })
  }

  async finalize(input: FinalizeMaterializationInput): Promise<ApplyMaterializationResult> {
    const session = this.requireSession(input.session)
    const { commit } = session.header
    // Recheck reservations at the durable boundary: callers may open more than one session in the
    // same transaction before either one finalizes.
    this.assertCommitAbsent(session.header)
    assertFinalizationCorrelations(session, input.finalization, this.state, this.objects)
    this.hooks.beforeWrite?.("finalize", session.writeOrdinal++)
    for (const activation of input.finalization.sourceActivations) {
      this.hooks.beforeWrite?.("source.activate", session.writeOrdinal++)
      assertTimestamp(activation.datasetVersion.createdAt, "Source dataset version createdAt")
      assertTimestamp(activation.updatedAt, "Source activation updatedAt")
      this.assertSource(activation.expected, commit.projectId)
      const candidateKey = sourceMaterializationKey(
        commit.projectId,
        activation.source.projectionId,
        activation.materializationId
      )
      const candidate = this.state.sourceMaterializations.get(candidateKey)
      if (!candidate || candidate.status !== "ready")
        throw new MaterializationConflictError(
          "source-materialization",
          "Source activation candidate is missing or is not ready."
        )
      const previous = findActiveSourceMaterialization(
        this.state,
        commit.projectId,
        activation.source.projectionId
      )
      if (previous) {
        this.state.sourceMaterializations.set(
          sourceMaterializationKey(
            previous.projectId,
            previous.source.projectionId,
            previous.materializationId
          ),
          {
            ...previous,
            status: "superseded",
            executionToken: null,
            terminalAt: activation.updatedAt,
            updatedAt: activation.updatedAt,
          }
        )
      }
      activateSourceRoots(this.state, candidate, activation)
      this.state.sourceMaterializations.set(candidateKey, {
        ...candidate,
        status: "active",
        executionToken: null,
        activatedAt: activation.updatedAt,
        lastCommitId: activation.lastCommitId,
        updatedAt: activation.updatedAt,
      })
    }
    if (session.plan) {
      this.state.replacementPlans.delete(
        replacementPlanKey({
          projectId: commit.projectId,
          source: { projectionId: session.plan.sourceId },
          materializationId: session.plan.materializationId,
        })
      )
    }
    const record = {
      ...structuredClone(commit),
      result: structuredClone(input.finalization.result),
    } as OntologyCommitRecord
    this.state.commitsById.set(commitKey(commit.projectId, commit.id), record)
    this.state.commitIdByIdempotency.set(
      idempotencyKey(commit.projectId, commit.idempotencyKey),
      commit.id
    )
    const origin = ontologyCommitOriginSelector(commit.origin)
    if (origin) {
      this.state.commitIdByOrigin.set(commitOriginKey(commit.projectId, origin), commit.id)
    }
    this.releaseSession(session)
    return { commit: structuredClone(record) }
  }

  /** @internal Share the existing transaction/session fence with derived vector writes. */
  assertVectorSession(session: MaterializationSession, projectId: string, commitId?: string): void {
    const active = this.requireSession(session)
    if (
      active.header.commit.projectId !== projectId ||
      (commitId !== undefined && active.header.commit.id !== commitId)
    ) {
      throw new MaterializationValidationError(
        "Vector mutation does not belong to this materialization session."
      )
    }
  }

  /** Begins a sealing step, and puts the work in canonical order the first time it seals. */
  private sealWork(session: SessionState, begin: (state: SessionState) => void): void {
    const sealed = session.workSealed
    begin(session)
    if (sealed) return
    session.applyWork.sort(comparePlanWork)
    session.cardinalityWork.sort(compareCardinalityWork)
    session.eventWork.sort(compareEventWork)
  }

  /** The fresh, fully planned plan a projection commit applies, with exactly its commit. */
  private requirePlan(header: MaterializationPlanHeader): InMemoryReplacementPlan {
    const { commit, plan: ref } = header
    const plan = ref
      ? this.state.replacementPlans.get(replacementPlanKey({ projectId: commit.projectId, ...ref }))
      : undefined
    if (!plan || commit.intent.kind !== "projection") {
      throw new MaterializationConflictError(
        "source-materialization",
        "A plan-bound session needs the open plan of a projection candidate."
      )
    }
    if (plan.commitId !== commit.id || plan.committedAt !== commit.committedAt) {
      invalidCorrelation("A plan-bound session must begin with the commit its plan carries.")
    }
    if (
      plan.watermark !== this.state.commitsById.size ||
      [...plan.identities.values()].some((identity) => identity.plannedRevision === null)
    ) {
      invalidCorrelation("A replacement plan applies only fully planned and just refreshed.")
    }
    return plan
  }

  private requireSession(session: MaterializationSession): SessionState {
    const value = this.sessions.get(session.providerToken)
    if (
      !value ||
      !value.active ||
      !this.getTransactionToken() ||
      this.getTransactionToken() !== value.transactionToken
    ) {
      throw new MaterializationConflictError(
        "effective-state",
        "Materialization session is inactive."
      )
    }
    return value
  }

  private assertCommitAbsent(header: MaterializationPlanHeader): void {
    if (this.state.commitsById.has(commitKey(header.commit.projectId, header.commit.id))) {
      throw new MaterializationConflictError(
        "idempotency",
        `Ontology commit '${header.commit.id}' already exists.`
      )
    }
    if (
      this.state.commitIdByIdempotency.has(
        idempotencyKey(header.commit.projectId, header.commit.idempotencyKey)
      )
    ) {
      throw new MaterializationConflictError(
        "idempotency",
        "Ontology idempotency key already exists."
      )
    }
    const origin = ontologyCommitOriginSelector(header.commit.origin)
    if (
      origin &&
      this.state.commitIdByOrigin.has(commitOriginKey(header.commit.projectId, origin))
    ) {
      throw new MaterializationConflictError(
        "run-correlation",
        "Ontology commit origin already has an authoritative commit."
      )
    }
  }

  private assertSource(expected: ExpectedSourceRevision, projectId: string): void {
    const current = findActiveSourceMaterialization(
      this.state,
      projectId,
      expected.source.projectionId
    )
    if (
      (current?.materializationId ?? null) !== expected.activeMaterializationId ||
      (current?.lastCommitId ?? null) !== expected.lastCommitId
    ) {
      throw new MaterializationConflictError(
        "projection-fence",
        `Source '${expected.source.projectionId}' changed.`
      )
    }
  }

  private async assertObject(expected: ExpectedObjectRevision, projectId: string): Promise<void> {
    this.assertObjectSync(expected, projectId)
  }

  private assertObjectSync(expected: ExpectedObjectRevision, projectId: string): void {
    const row = getInMemoryObjectMaterializerAdapter(this.objects).getExactObjectRow(
      projectId,
      expected.ref.objectTypeId,
      expected.ref.primaryId
    )
    assertExpectedObjectRevision(row ?? null, expected)
  }

  private async assertLink(expected: ExpectedLinkRevision, projectId: string): Promise<void> {
    this.assertLinkSync(expected, projectId)
  }

  private assertLinkSync(expected: ExpectedLinkRevision, projectId: string): void {
    const row = getInMemoryObjectMaterializerAdapter(this.objects).getExactLinkRow(projectId, {
      sourceTypeId: expected.ref.source.objectTypeId,
      sourceId: expected.ref.source.primaryId,
      linkId: expected.ref.linkId,
      targetTypeId: expected.ref.target.objectTypeId,
      targetId: expected.ref.target.primaryId,
    })
    assertExpectedLinkRevision(row?.lastCommitId, expected)
  }

  private assertPoint(expected: ExpectedTimeseriesPointRevision, projectId: string): void {
    const point = getInMemoryTimeseriesMaterializerAdapter(this.timeseries).getExactPoint(
      projectId,
      expected.series,
      expected.at
    )
    if ((point?.lastCommitId ?? null) !== expected.lastCommitId) {
      throw new MaterializationConflictError(
        "timeseries-point",
        `Telemetry point ${telemetryPointKey(expected.series, expected.at)} changed.`
      )
    }
  }

  private linkSlotState(
    session: SessionState,
    source: OntologyObjectRef,
    linkId: string
  ): MaterializationLinkScopeState {
    session.linkSlotStates ??= new Map()
    const key = linkScopeSortKey(source, linkId)
    const existing = session.linkSlotStates.get(key)
    if (existing) return structuredClone(existing)
    const computed = this.reader.linkSlotState(session.header.commit.projectId, source, linkId)
    session.linkSlotStates.set(key, computed)
    return structuredClone(computed)
  }

  private incidentLinkRefs(
    session: SessionState,
    objects: readonly OntologyObjectRef[]
  ): readonly OntologyLinkRef[] {
    if (objects.length === 0) return []
    session.incidentLinksByObject ??= this.reader.incidentLinkIndex(session.header.commit.projectId)
    const selected = new Map<string, OntologyLinkRef>()
    for (const object of objects) {
      for (const ref of session.incidentLinksByObject.get(objectRefKey(object)) ?? []) {
        selected.set(linkRefSortKey(ref), ref)
      }
    }
    return [...selected.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([, ref]) => ref)
  }
}
