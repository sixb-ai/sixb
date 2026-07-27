import { stableJsonStringify } from "../../../json"
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
  linkScopeSortKey,
  objectRefKey,
  objectRefSortKey,
  projectionEntityKey,
  telemetryPointKey,
  telemetryPointSortKey,
} from "../../../materialization/refs"
import {
  getInMemoryObjectMaterializerAdapter,
  type InMemoryObjectStorage,
} from "../../objects/in-memory"
import type { ObjectLinkRow } from "../../objects/types"
import {
  getInMemoryTimeseriesMaterializerAdapter,
  type InMemoryTimeseriesStorage,
} from "../../timeseries/store"
import type { OntologyCommitRecord } from "../commits"
import type {
  ApplyMaterializationChunkInput,
  ApplyMaterializationResult,
  ExpectedSourceRevision,
  ExpectedTimeseriesPointRevision,
  FinalizeMaterializationInput,
  MaterializationCardinalityOccupantWorkRecord,
  MaterializationEventWorkRecord,
  MaterializationLinkScopeState,
  MaterializationLinkState,
  MaterializationObjectExistence,
  MaterializationObjectExistenceWorkRecord,
  MaterializationObjectState,
  MaterializationPlanHeader,
  MaterializationPlanWorkRecord,
  MaterializationSession,
  MaterializationStatePage,
  MaterializationWorkPage,
  MaterializationWorkRecord,
  OntologyMaterializationStorage,
  ReadMaterializationObjectExistenceInput,
  SourceReplacementLinkState,
  SourceReplacementObjectState,
  SourceReplacementStatePage,
  StageMaterializationWorkInput,
  StoredTelemetryPoint,
  StreamMaterializationStateInput,
  StreamMaterializationWorkInput,
  StreamSourceReplacementStateInput,
} from "../materializations"
import type { OntologyMaterializationEvent } from "../outbox"
import {
  appendScopeSnapshot,
  finishScopeAccumulator,
  type ProviderMaterializationTransactionLifecycle,
  startScopeAccumulator,
  uniqueSorted,
} from "../provider"
import type {
  StoredSourceAssertion,
  StoredSourceLinkAssertion,
  StoredSourceObjectAssertion,
} from "../sources"
import { assertFinalizationCorrelations } from "./materializations-finalization"
import {
  addReplacementLink,
  findActiveSourceMaterialization,
  linkRef,
  linkSnapshot,
  objectSnapshot,
  publicLinkOverride,
  publicObjectOverride,
  storedPoint,
  storedSource,
  storedSourceLink,
  storedSourceObject,
  uniqueBy,
} from "./materializations-state"
import {
  assertChunkSequence,
  assertLastCommit,
  assertMaterializationHeader,
  assertPageRows,
  assertPlanChunkCorrelations,
  assertWorkRecord,
  compareCardinalityWork,
  compareEventWork,
  comparePlanWork,
  materializationChunkRows,
  materializationPlanItems,
  workUniquenessKey,
} from "./materializations-work"
import {
  assertTimestamp,
  commitKey,
  commitOriginKey,
  type InMemoryOntologyState,
  type InMemoryOntologyStorageTestHooks,
  type InMemorySourceMaterialization,
  idempotencyKey,
  ontologyCommitOriginSelector,
  outboxKey,
  projectEntityKey,
  sourceMaterializationKey,
} from "./shared-state"

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
  readonly appliedPlanItems: string[]
  readonly outboxEnvelopes: Map<number, OntologyMaterializationEvent>
  readonly workStreams: Record<StreamMaterializationWorkInput["order"], WorkStreamState>
  workSealed: boolean
  incidentLinksByObject: Map<string, readonly OntologyLinkRef[]> | null
  linkScopeStates: Map<string, MaterializationLinkScopeState> | null
  readonly objectExistence: Map<string, MaterializationObjectExistenceWorkRecord>
  replacement: ReplacementSessionState | null
}

export interface WorkStreamState {
  started: boolean
  completed: boolean
  emittedCount: number
}

export interface ReplacementObjectWork {
  readonly ref: OntologyObjectRef
  readonly sortKey: string
}

export interface ReplacementLinkWork {
  readonly ref: OntologyLinkRef
  readonly sortKey: string
  diffRequired: boolean
}

export interface ReplacementSessionState {
  readonly sourceId: string
  readonly candidateMaterializationId: string
  readonly previous: InMemorySourceMaterialization | undefined
  readonly candidate: InMemorySourceMaterialization
  readonly objects: Map<string, ReplacementObjectWork>
  readonly links: Map<string, ReplacementLinkWork>
  orderedObjects: ReplacementObjectWork[]
  orderedLinks: ReplacementLinkWork[] | null
  readonly affectedScopes: Set<string>
  readonly incidentObjects: Map<string, OntologyObjectRef>
  objectStreamStarted: boolean
  objectStreamCompleted: boolean
  linkStreamStarted: boolean
  linkStreamCompleted: boolean
  linksExpanded: boolean
}

export class InMemoryOntologyMaterializationStorage implements OntologyMaterializationStorage {
  private readonly sessions = new WeakMap<object, SessionState>()
  private readonly liveSessions = new Set<SessionState>()

  constructor(
    private readonly state: InMemoryOntologyState,
    private readonly objects: InMemoryObjectStorage,
    private readonly timeseries: InMemoryTimeseriesStorage,
    private readonly getTransactionToken: () => object | null,
    private readonly getMaterializationLifecycle: () => ProviderMaterializationTransactionLifecycle | null,
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
    this.assertCommitAbsent(input)
    for (const expected of input.expected.sources)
      this.assertSource(expected, input.commit.projectId)
    for (const expected of input.expected.objects)
      await this.assertObject(expected, input.commit.projectId)
    for (const expected of input.expected.links)
      await this.assertLink(expected, input.commit.projectId)
    const expectedScopeStates = new Map<string, MaterializationLinkScopeState>()
    for (const expected of input.expected.linkScopes) {
      const key = linkScopeSortKey(expected.source, expected.linkId)
      const current =
        expectedScopeStates.get(key) ??
        this.computeLinkScopeState(input.commit.projectId, expected.source, expected.linkId)
      expectedScopeStates.set(key, current)
      if (current.fingerprint !== expected.fingerprint) {
        throw new MaterializationConflictError(
          "effective-state",
          `Expected link scope changed for ${expected.source.objectTypeId}:${expected.source.primaryId}.${expected.linkId}.`
        )
      }
    }
    for (const expected of input.expected.points) this.assertPoint(expected, input.commit.projectId)

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
      appliedPlanItems: [],
      outboxEnvelopes: new Map<number, OntologyMaterializationEvent>(),
      workStreams: {
        apply: { started: false, completed: false, emittedCount: 0 },
        cardinality: { started: false, completed: false, emittedCount: 0 },
        event: { started: false, completed: false, emittedCount: 0 },
      },
      workSealed: false,
      incidentLinksByObject: null,
      linkScopeStates: expectedScopeStates,
      objectExistence: new Map<string, MaterializationObjectExistenceWorkRecord>(),
      replacement: null,
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
    session.appliedPlanItems.length = 0
    session.outboxEnvelopes.clear()
    session.incidentLinksByObject = null
    session.linkScopeStates = null
    session.objectExistence.clear()
    session.replacement = null
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
          objects.push(await this.objectState(session, ref))
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
          links.push(await this.linkState(session, ref))
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
        for (const ref of refs) links.push(await this.linkState(session, ref))
        this.requireSession(input.session)
        this.hooks.observeBuffer?.("state.incident-link.page", links.length)
        yield { objects: [], links, linkScopes: [], points: [] }
      }

      for (const scope of uniqueBy(request.linkScopes, (value) =>
        linkScopeSortKey(value.source, value.linkId)
      )) {
        this.requireSession(input.session)
        const value = this.linkScopeState(session, scope.source, scope.linkId)
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

  async *streamSourceReplacementState(
    input: StreamSourceReplacementStateInput
  ): AsyncIterable<SourceReplacementStatePage> {
    const session = this.requireSession(input.session)
    assertPageRows(input.pageRows)
    const replacement = this.requireReplacement(session, input)
    if (input.entityKind === "object") {
      if (replacement.candidate.projectionKind !== "object") {
        throw new MaterializationConflictError(
          "source-materialization",
          "Link projection replacement cannot stream object state."
        )
      }
      if (replacement.objectStreamStarted)
        throw new MaterializationConflictError(
          "effective-state",
          "Replacement object state may only be streamed once per session."
        )
      replacement.objectStreamStarted = true
      this.hooks.beforeRead?.("source-replacement.object")
      for (let offset = 0; offset < replacement.orderedObjects.length; offset += input.pageRows) {
        this.requireSession(input.session)
        const selected = replacement.orderedObjects.slice(offset, offset + input.pageRows)
        const objects: SourceReplacementObjectState[] = []
        for (const entry of selected) {
          const key = projectionEntityKey({ kind: "object", ref: entry.ref })
          const base = await this.objectState(session, entry.ref)
          objects.push({
            ref: base.ref,
            candidateSource: storedSourceObject(
              input.source.projectionId,
              replacement.candidate.materializationId,
              replacement.candidate.rowsByEntity.get(key)
            ),
            override: base.override,
            effective: base.effective,
            latestTelemetry: base.latestTelemetry,
          })
        }
        this.requireSession(input.session)
        this.hooks.observeBuffer?.("replacement.object.page", objects.length)
        yield { objects, links: [] }
      }
      this.requireSession(input.session)
      replacement.objectStreamCompleted = true
      return
    }

    if (replacement.candidate.projectionKind === "object" && !replacement.objectStreamCompleted) {
      throw new MaterializationConflictError(
        "effective-state",
        "Object projection replacement must fully stream object state before link state."
      )
    }
    if (replacement.linkStreamStarted)
      throw new MaterializationConflictError(
        "effective-state",
        "Replacement link state may only be streamed once per session."
      )
    replacement.linkStreamStarted = true
    this.hooks.beforeRead?.("source-replacement.link")
    this.expandReplacementLinks(session, replacement)
    replacement.orderedLinks ??= [...replacement.links.values()].sort((left, right) =>
      left.sortKey.localeCompare(right.sortKey)
    )
    for (let offset = 0; offset < replacement.orderedLinks.length; offset += input.pageRows) {
      this.requireSession(input.session)
      const selected = replacement.orderedLinks.slice(offset, offset + input.pageRows)
      const links: SourceReplacementLinkState[] = []
      for (const entry of selected) {
        const key = projectionEntityKey({ kind: "link", ref: entry.ref })
        const base = await this.linkState(session, entry.ref)
        const ownedByReplacement =
          replacement.previous?.rowsByEntity.has(key) || replacement.candidate.rowsByEntity.has(key)
        links.push({
          ref: base.ref,
          candidateSource: ownedByReplacement
            ? storedSourceLink(
                input.source.projectionId,
                replacement.candidate.materializationId,
                replacement.candidate.rowsByEntity.get(key)
              )
            : base.source,
          override: base.override,
          effective: base.effective,
          diffRequired: entry.diffRequired,
        })
      }
      this.requireSession(input.session)
      this.hooks.observeBuffer?.("replacement.link.page", links.length)
      yield { objects: [], links }
    }
    this.requireSession(input.session)
    replacement.linkStreamCompleted = true
  }

  async stageWork(input: StageMaterializationWorkInput): Promise<void> {
    const session = this.requireSession(input.session)
    if (session.workSealed) {
      throw new MaterializationConflictError(
        "effective-state",
        "Materialization work cannot be staged after draining begins."
      )
    }
    const batchKeys = new Set<string>()
    const batchUniqueKeys = new Set<string>()
    for (const record of input.records) {
      assertWorkRecord(record, session.header)
      const uniqueKey = workUniquenessKey(record)
      if (
        batchKeys.has(record.recordKey) ||
        session.work.has(record.recordKey) ||
        batchUniqueKeys.has(uniqueKey) ||
        session.workUniqueKeys.has(uniqueKey)
      ) {
        throw new MaterializationConflictError(
          "effective-state",
          `Duplicate materialization work key '${record.recordKey}'.`
        )
      }
      if (
        record.kind === "incident-object" &&
        (!session.replacement || session.replacement.linkStreamStarted)
      ) {
        throw new MaterializationConflictError(
          "effective-state",
          "Incident replacement work must be staged before link state is streamed."
        )
      }
      batchKeys.add(record.recordKey)
      batchUniqueKeys.add(uniqueKey)
    }
    const cloned = input.records.map((record) => structuredClone(record))
    this.hooks.observeWork?.(cloned)
    for (const record of cloned) {
      session.work.set(record.recordKey, record)
      session.workUniqueKeys.add(workUniquenessKey(record))
      if (record.kind === "plan") session.applyWork.push(record)
      if (record.kind === "cardinality") session.cardinalityWork.push(record)
      if (record.kind === "event") session.eventWork.push(record)
      if (record.kind === "object-existence") {
        session.objectExistence.set(objectRefKey(record.ref), record)
      }
      if (record.kind === "incident-object") {
        const replacement = session.replacement
        if (replacement) {
          replacement.incidentObjects.set(objectRefKey(record.ref), record.ref)
          replacement.linksExpanded = false
          replacement.orderedLinks = null
        }
      }
    }
    this.hooks.observeBuffer?.("work.stage", cloned.length)
  }

  async *streamWork(input: StreamMaterializationWorkInput): AsyncIterable<MaterializationWorkPage> {
    const session = this.requireSession(input.session)
    assertPageRows(input.pageRows)
    const stream = session.workStreams[input.order]
    if (stream.started) {
      throw new MaterializationConflictError(
        "effective-state",
        `Materialization ${input.order} work may only be streamed once per session.`
      )
    }
    stream.started = true
    if (!session.workSealed) {
      session.applyWork.sort(comparePlanWork)
      session.cardinalityWork.sort(compareCardinalityWork)
      session.eventWork.sort(compareEventWork)
      session.workSealed = true
    }
    const records =
      input.order === "apply"
        ? session.applyWork
        : input.order === "cardinality"
          ? session.cardinalityWork
          : session.eventWork
    for (let offset = 0; offset < records.length; offset += input.pageRows) {
      this.requireSession(input.session)
      const selected = records.slice(offset, offset + input.pageRows)
      this.hooks.observeBuffer?.(`work.${input.order}.page`, selected.length)
      stream.emittedCount = offset + selected.length
      yield { records: structuredClone(selected) }
    }
    this.requireSession(input.session)
    stream.completed = true
  }

  async readObjectExistence(
    input: ReadMaterializationObjectExistenceInput
  ): Promise<readonly MaterializationObjectExistence[]> {
    const session = this.requireSession(input.session)
    const result: MaterializationObjectExistence[] = []
    for (const ref of input.refs) {
      const record = session.objectExistence.get(objectRefKey(ref))
      if (record) {
        result.push({ ref: structuredClone(record.ref), exists: record.exists })
      }
    }
    return result
  }

  async applyChunk(input: ApplyMaterializationChunkInput): Promise<void> {
    const session = this.requireSession(input.session)
    const projectId = session.header.commit.projectId
    assertPlanChunkCorrelations(input.chunk, session.header.commit)
    assertChunkSequence(session, input.chunk)
    this.hooks.observeBuffer?.("apply.chunk", materializationChunkRows(input.chunk))
    const write = (boundary: string, apply: () => void): void => {
      this.hooks.beforeWrite?.(boundary, session.writeOrdinal++)
      apply()
    }

    for (const item of input.chunk.overrides.objectUpserts)
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
            lastCommitId: item.lastCommitId,
            updatedAt: item.updatedAt,
          })
        )
      })
    for (const item of input.chunk.overrides.objectDeletes)
      write("override.object.delete", () => {
        const key = projectEntityKey(projectId, objectRefKey(item.ref))
        assertLastCommit(
          this.state.objectOverrides.get(key),
          item.expectedLastCommitId,
          "object override"
        )
        this.state.objectOverrides.delete(key)
      })
    for (const item of input.chunk.overrides.linkUpserts)
      write("override.link.upsert", () => {
        const key = projectEntityKey(projectId, linkRefKey(item.ref))
        assertLastCommit(
          this.state.linkOverrides.get(key),
          item.expectedLastCommitId,
          "link override"
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
    for (const item of input.chunk.overrides.linkDeletes)
      write("override.link.delete", () => {
        const key = projectEntityKey(projectId, linkRefKey(item.ref))
        assertLastCommit(
          this.state.linkOverrides.get(key),
          item.expectedLastCommitId,
          "link override"
        )
        this.state.linkOverrides.delete(key)
      })

    for (const item of input.chunk.effective.linkDeletes)
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
    for (const item of input.chunk.effective.objectDeletes)
      write("effective.object.delete", () => {
        this.assertObjectSync(item.expected, projectId)
        getInMemoryObjectMaterializerAdapter(this.objects).deleteExactObject(
          projectId,
          item.ref.objectTypeId,
          item.ref.primaryId
        )
      })
    for (const item of input.chunk.effective.objectUpserts)
      write("effective.object.upsert", () => {
        this.assertObjectSync(item.expected, projectId)
        getInMemoryObjectMaterializerAdapter(this.objects).applyExactObject(item.row, projectId)
      })
    for (const item of input.chunk.effective.linkUpserts)
      write("effective.link.upsert", () => {
        this.assertLinkSync(item.expected, projectId)
        getInMemoryObjectMaterializerAdapter(this.objects).applyExactLink(item.row, projectId)
      })
    for (const item of input.chunk.timeseries.pointUpserts)
      write("timeseries.point.upsert", () => {
        this.assertPoint(item.expected, projectId)
        getInMemoryTimeseriesMaterializerAdapter(this.timeseries).applyExactPoint(
          projectId,
          item.point
        )
      })
    for (const item of input.chunk.outbox)
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
          lastError: null,
          createdAt: item.createdAt,
        })
        session.outboxEnvelopes.set(envelope.commitOrdinal, structuredClone(envelope))
      })
    for (const item of materializationPlanItems(input.chunk)) {
      session.appliedPlanItems.push(stableJsonStringify(item))
    }
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
      this.state.sourceMaterializations.set(candidateKey, {
        ...candidate,
        status: "active",
        executionToken: null,
        activatedAt: activation.updatedAt,
        lastCommitId: activation.lastCommitId,
        updatedAt: activation.updatedAt,
      })
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

  private requireReplacement(
    session: SessionState,
    input: StreamSourceReplacementStateInput
  ): ReplacementSessionState {
    if (session.replacement) {
      if (
        session.replacement.sourceId !== input.source.projectionId ||
        session.replacement.candidateMaterializationId !== input.candidateMaterializationId
      ) {
        throw new MaterializationConflictError(
          "source-materialization",
          "Materialization session already owns another replacement union."
        )
      }
      return session.replacement
    }
    const projectId = session.header.commit.projectId
    const sourceId = input.source.projectionId
    const candidate = this.state.sourceMaterializations.get(
      sourceMaterializationKey(projectId, sourceId, input.candidateMaterializationId)
    )
    if (!candidate || candidate.status !== "ready") {
      throw new MaterializationConflictError(
        "source-materialization",
        `Candidate source materialization '${input.candidateMaterializationId}' is missing or is not ready.`
      )
    }
    const previous = findActiveSourceMaterialization(this.state, projectId, sourceId)
    if (
      candidate.protocol !== "replacement" ||
      (previous &&
        (previous.protocol !== candidate.protocol ||
          previous.projectionKind !== candidate.projectionKind))
    ) {
      throw new MaterializationConflictError(
        "source-materialization",
        "Source replacement kind or protocol does not match its active materialization."
      )
    }
    const replacement: ReplacementSessionState = {
      sourceId,
      candidateMaterializationId: input.candidateMaterializationId,
      previous,
      candidate,
      objects: new Map(),
      links: new Map(),
      orderedObjects: [],
      orderedLinks: null,
      affectedScopes: new Set(),
      incidentObjects: new Map(),
      objectStreamStarted: false,
      objectStreamCompleted: false,
      linkStreamStarted: false,
      linkStreamCompleted: false,
      linksExpanded: false,
    }
    for (const materialization of [previous, candidate]) {
      if (!materialization) continue
      for (const row of materialization.rowsByEntity.values()) {
        if (row.assertion.kind === "object") {
          const ref = row.assertion.ref
          replacement.objects.set(objectRefKey(ref), { ref, sortKey: objectRefSortKey(ref) })
        } else {
          addReplacementLink(replacement, row.assertion.ref, true)
        }
      }
    }
    replacement.orderedObjects = [...replacement.objects.values()].sort((left, right) =>
      left.sortKey.localeCompare(right.sortKey)
    )
    session.replacement = replacement
    return replacement
  }

  private expandReplacementLinks(
    session: SessionState,
    replacement: ReplacementSessionState
  ): void {
    if (replacement.linksExpanded) return
    const projectId = session.header.commit.projectId
    const incident = replacement.incidentObjects
    const touchesIncident = (ref: OntologyLinkRef): boolean =>
      incident.has(objectRefKey(ref.source)) || incident.has(objectRefKey(ref.target))

    const adapter = getInMemoryObjectMaterializerAdapter(this.objects)
    adapter.visitExactLinks(projectId, (row) => {
      const ref = linkRef(row)
      if (touchesIncident(ref)) addReplacementLink(replacement, ref, true)
    })
    for (const override of this.state.linkOverrides.values()) {
      if (override.projectId !== projectId) continue
      if (touchesIncident(override.ref)) addReplacementLink(replacement, override.ref, true)
    }
    for (const active of this.state.sourceMaterializations.values()) {
      if (active.projectId !== projectId || active.status !== "active") continue
      for (const row of active.rowsByEntity.values()) {
        if (row.assertion.kind === "link" && touchesIncident(row.assertion.ref)) {
          addReplacementLink(replacement, row.assertion.ref, true)
        }
      }
    }

    adapter.visitExactLinks(projectId, (row) => {
      const ref = linkRef(row)
      if (replacement.affectedScopes.has(linkScopeSortKey(ref.source, ref.linkId))) {
        addReplacementLink(replacement, ref, false)
      }
    })
    replacement.linksExpanded = true
    replacement.orderedLinks = null
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
    if (!expected.exists) {
      if (row)
        throw new MaterializationConflictError(
          "effective-state",
          `Expected object ${objectRefKey(expected.ref)} to be absent.`
        )
      return
    }
    if (!row || row.version !== expected.version || row.lastCommitId !== expected.lastCommitId) {
      throw new MaterializationConflictError(
        "effective-state",
        `Expected object ${objectRefKey(expected.ref)} changed.`
      )
    }
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
    if (!expected.exists) {
      if (row)
        throw new MaterializationConflictError(
          "effective-state",
          `Expected link ${linkRefKey(expected.ref)} to be absent.`
        )
      return
    }
    if (!row || row.lastCommitId !== expected.lastCommitId) {
      throw new MaterializationConflictError(
        "effective-state",
        `Expected link ${linkRefKey(expected.ref)} changed.`
      )
    }
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

  private async objectState(
    session: SessionState,
    ref: OntologyObjectRef
  ): Promise<MaterializationObjectState> {
    const projectId = session.header.commit.projectId
    const row = await this.objects.getByPrimaryId({
      projectId,
      objectTypeId: ref.objectTypeId,
      primaryId: ref.primaryId,
    })
    return {
      ref: structuredClone(ref),
      source: this.findActiveObjectSource(projectId, ref),
      override: structuredClone(
        publicObjectOverride(
          this.state.objectOverrides.get(projectEntityKey(projectId, objectRefKey(ref)))
        )
      ),
      effective: row ? objectSnapshot(row) : null,
      latestTelemetry: getInMemoryTimeseriesMaterializerAdapter(this.timeseries)
        .listLatestForObject(projectId, ref.objectTypeId, ref.primaryId)
        .map(storedPoint),
    }
  }

  private async linkState(
    session: SessionState,
    ref: OntologyLinkRef
  ): Promise<MaterializationLinkState> {
    const projectId = session.header.commit.projectId
    const row = getInMemoryObjectMaterializerAdapter(this.objects).getExactLinkRow(projectId, {
      sourceTypeId: ref.source.objectTypeId,
      sourceId: ref.source.primaryId,
      linkId: ref.linkId,
      targetTypeId: ref.target.objectTypeId,
      targetId: ref.target.primaryId,
    })
    return {
      ref: structuredClone(ref),
      source: this.findActiveLinkSource(projectId, ref),
      override: structuredClone(
        publicLinkOverride(
          this.state.linkOverrides.get(projectEntityKey(projectId, linkRefKey(ref)))
        )
      ),
      effective: row ? linkSnapshot(row) : null,
    }
  }

  private linkScopeState(
    session: SessionState,
    source: OntologyObjectRef,
    linkId: string
  ): MaterializationLinkScopeState {
    session.linkScopeStates ??= new Map()
    const key = linkScopeSortKey(source, linkId)
    const existing = session.linkScopeStates.get(key)
    if (existing) return structuredClone(existing)
    const computed = this.computeLinkScopeState(session.header.commit.projectId, source, linkId)
    session.linkScopeStates.set(key, computed)
    return structuredClone(computed)
  }

  private computeLinkScopeState(
    projectId: string,
    source: OntologyObjectRef,
    linkId: string
  ): MaterializationLinkScopeState {
    const rows: ObjectLinkRow[] = []
    getInMemoryObjectMaterializerAdapter(this.objects).visitExactScopeLinks(
      projectId,
      source.objectTypeId,
      source.primaryId,
      linkId,
      (row) => rows.push(row)
    )
    rows.sort((left, right) =>
      linkRefSortKey(linkRef(left)).localeCompare(linkRefSortKey(linkRef(right)))
    )
    const accumulator = startScopeAccumulator(source, linkId, linkScopeSortKey(source, linkId))
    for (let offset = 0; offset < rows.length; offset += 1_000) {
      const page = rows.slice(offset, offset + 1_000)
      this.hooks.observeBuffer?.("state.link-scope.page", page.length)
      for (const row of page) {
        appendScopeSnapshot(accumulator, linkSnapshot(row))
      }
    }
    return finishScopeAccumulator(accumulator)
  }

  private findActiveObjectSource(
    projectId: string,
    ref: OntologyObjectRef
  ): StoredSourceObjectAssertion | null {
    const found = this.findActiveSource(projectId, projectionEntityKey({ kind: "object", ref }))
    return found?.assertion.kind === "object" ? (found as StoredSourceObjectAssertion) : null
  }

  private findActiveLinkSource(
    projectId: string,
    ref: OntologyLinkRef
  ): StoredSourceLinkAssertion | null {
    const found = this.findActiveSource(projectId, projectionEntityKey({ kind: "link", ref }))
    return found?.assertion.kind === "link" ? (found as StoredSourceLinkAssertion) : null
  }

  private findActiveSource(projectId: string, entityKey: string): StoredSourceAssertion | null {
    let found: StoredSourceAssertion | null = null
    for (const active of this.state.sourceMaterializations.values()) {
      if (active.projectId !== projectId || active.status !== "active") continue
      const row = active.rowsByEntity.get(entityKey)
      if (!row) continue
      if (found)
        throw new MaterializationConflictError(
          "source-materialization",
          `Multiple active sources assert ${entityKey}.`
        )
      found = storedSource(active.source.projectionId, active.materializationId, row)
    }
    return structuredClone(found)
  }

  private incidentLinkRefs(
    session: SessionState,
    objects: readonly OntologyObjectRef[]
  ): readonly OntologyLinkRef[] {
    if (objects.length === 0) return []
    session.incidentLinksByObject ??= this.buildIncidentLinkIndex(session.header.commit.projectId)
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

  private buildIncidentLinkIndex(projectId: string): Map<string, readonly OntologyLinkRef[]> {
    const mutable = new Map<string, Map<string, OntologyLinkRef>>()
    const consider = (ref: OntologyLinkRef): void => {
      const sortKey = linkRefSortKey(ref)
      for (const endpoint of [ref.source, ref.target]) {
        const key = objectRefKey(endpoint)
        const links = mutable.get(key) ?? new Map<string, OntologyLinkRef>()
        links.set(sortKey, structuredClone(ref))
        mutable.set(key, links)
      }
    }
    getInMemoryObjectMaterializerAdapter(this.objects).visitExactLinks(projectId, (row) =>
      consider(linkRef(row))
    )
    for (const override of this.state.linkOverrides.values()) {
      if (override.projectId === projectId) consider(override.ref)
    }
    for (const active of this.state.sourceMaterializations.values()) {
      if (active.projectId !== projectId || active.status !== "active") continue
      for (const row of active.rowsByEntity.values()) {
        if (row.assertion.kind === "link") consider(row.assertion.ref)
      }
    }
    const index = new Map<string, readonly OntologyLinkRef[]>()
    for (const [objectKey, refs] of mutable) {
      index.set(
        objectKey,
        [...refs.entries()]
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([, ref]) => ref)
      )
    }
    return index
  }
}
