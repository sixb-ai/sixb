import { createHash } from "node:crypto"
import { stableJsonStringify } from "../../../json"
import {
  MaterializationConflictError,
  MaterializationValidationError,
} from "../../../materialization/errors"
import { createEventId, materializationEventKindOrdinal } from "../../../materialization/identity"
import type {
  EffectiveChangeCounts,
  EffectiveLinkSnapshot,
  EffectiveObjectSnapshot,
  ExpectedLinkRevision,
  ExpectedObjectRevision,
  OntologyLinkRef,
  OntologyObjectRef,
  PinnedDatasetVersion,
  TelemetryCommitResult,
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
import type { ObjectLinkRow, ObjectRow } from "../../objects/types"
import {
  getInMemoryTimeseriesMaterializerAdapter,
  type InMemoryTimeseriesStorage,
} from "../../timeseries/store"
import type { TimeseriesPoint } from "../../timeseries/types"
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
  MaterializationPlanWorkItem,
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
  StoredLinkOverride,
  StoredObjectOverride,
  StoredTelemetryPoint,
  StreamMaterializationStateInput,
  StreamMaterializationWorkInput,
  StreamSourceReplacementStateInput,
} from "../materializations"
import type { OntologyMaterializationEvent } from "../outbox"
import type {
  StageSourceAssertion,
  StoredSourceAssertion,
  StoredSourceLinkAssertion,
  StoredSourceObjectAssertion,
} from "../sources"
import {
  commitKey,
  commitOriginKey,
  type InMemoryOntologyState,
  type InMemoryOntologyStorageTestHooks,
  type InMemorySourceMaterialization,
  type InMemoryStoredLinkOverride,
  type InMemoryStoredObjectOverride,
  idempotencyKey,
  ontologyCommitOriginSelector,
  outboxKey,
  projectEntityKey,
  sourceMaterializationKey,
} from "./shared-state"

interface SessionState {
  readonly header: MaterializationPlanHeader
  readonly transactionToken: object
  active: boolean
  writeOrdinal: number
  outboxCount: number
  readonly outboxOrdinals: Set<number>
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

interface WorkStreamState {
  started: boolean
  completed: boolean
  emittedCount: number
}

interface ReplacementObjectWork {
  readonly ref: OntologyObjectRef
  readonly sortKey: string
}

interface ReplacementLinkWork {
  readonly ref: OntologyLinkRef
  readonly sortKey: string
  diffRequired: boolean
}

interface ReplacementSessionState {
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
    private readonly hooks: InMemoryOntologyStorageTestHooks = {}
  ) {}

  async begin(input: MaterializationPlanHeader): Promise<MaterializationSession> {
    const transactionToken = this.getTransactionToken()
    if (!transactionToken) {
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
      header: structuredClone(input),
      transactionToken,
      active: true,
      writeOrdinal: 0,
      outboxCount: 0,
      outboxOrdinals: new Set<number>(),
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
    return { providerToken }
  }

  deactivateTransaction(transactionToken: object): void {
    for (const session of this.liveSessions) {
      if (session.transactionToken !== transactionToken) continue
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
    }
  }

  async *streamState(
    input: StreamMaterializationStateInput
  ): AsyncIterable<MaterializationStatePage> {
    const session = this.requireSession(input.session)
    assertPageRows(input.pageRows)
    for await (const request of input.requests) {
      this.requireSession(input.session)
      this.hooks.beforeRead?.("state.read")
      let objectCursor: string | null = null
      while (true) {
        this.requireSession(input.session)
        const refs = selectBoundedUnique(
          request.objects,
          objectCursor,
          input.pageRows,
          objectRefSortKey,
          objectRefKey
        )
        if (refs.length === 0) break
        const objects: MaterializationObjectState[] = []
        for (const ref of refs) objects.push(await this.objectState(session, ref))
        this.requireSession(input.session)
        this.hooks.observeBuffer?.("state.object.page", objects.length)
        yield { objects, links: [], linkScopes: [], points: [] }
        objectCursor = objectRefSortKey(refs[refs.length - 1])
      }

      let linkCursor: string | null = null
      while (true) {
        this.requireSession(input.session)
        const refs = selectBoundedUnique(
          request.links,
          linkCursor,
          input.pageRows,
          linkRefSortKey,
          linkRefKey
        )
        if (refs.length === 0) break
        const links: MaterializationLinkState[] = []
        for (const ref of refs) links.push(await this.linkState(session, ref))
        this.requireSession(input.session)
        this.hooks.observeBuffer?.("state.link.page", links.length)
        yield { objects: [], links, linkScopes: [], points: [] }
        linkCursor = linkRefSortKey(refs[refs.length - 1])
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

      let pointCursor: string | null = null
      while (true) {
        this.requireSession(input.session)
        const selected = selectBoundedUnique(
          request.points,
          pointCursor,
          input.pageRows,
          (point) => telemetryPointSortKey(point.series, point.at),
          (point) => telemetryPointKey(point.series, point.at)
        )
        if (selected.length === 0) break
        const points: StoredTelemetryPoint[] = []
        for (const point of selected) {
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
        pointCursor = telemetryPointSortKey(
          selected[selected.length - 1].series,
          selected[selected.length - 1].at
        )
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
        yield { objects, links: [], linkScopes: [] }
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
      yield { objects: [], links, linkScopes: [] }
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
        if (session.outboxOrdinals.has(envelope.commitOrdinal))
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
        session.outboxOrdinals.add(envelope.commitOrdinal)
        session.outboxEnvelopes.set(envelope.commitOrdinal, structuredClone(envelope))
        session.outboxCount += 1
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

function publicObjectOverride(
  value: InMemoryStoredObjectOverride | undefined
): StoredObjectOverride | null {
  if (!value) return null
  const { projectId: _, ...stored } = value
  return stored
}

function publicLinkOverride(
  value: InMemoryStoredLinkOverride | undefined
): StoredLinkOverride | null {
  if (!value) return null
  const { projectId: _, ...stored } = value
  return stored
}

interface LinkScopeAccumulator {
  readonly scopeSortKey: string
  readonly source: OntologyObjectRef
  readonly linkId: string
  readonly hash: ReturnType<typeof createHash>
  effectiveCount: number
}

function startScopeAccumulator(
  source: OntologyObjectRef,
  linkId: string,
  scopeSortKey: string
): LinkScopeAccumulator {
  const hash = createHash("sha256")
  hash.update("[")
  return {
    scopeSortKey,
    source: structuredClone(source),
    linkId,
    hash,
    effectiveCount: 0,
  }
}

function appendScopeSnapshot(
  accumulator: LinkScopeAccumulator,
  snapshot: EffectiveLinkSnapshot
): void {
  if (accumulator.effectiveCount > 0) accumulator.hash.update(",")
  accumulator.hash.update(
    stableJsonStringify({
      ref: snapshot.ref,
      properties: snapshot.properties ?? {},
      lastCommitId: snapshot.lastCommitId,
    })
  )
  accumulator.effectiveCount += 1
}

function finishScopeAccumulator(accumulator: LinkScopeAccumulator): MaterializationLinkScopeState {
  accumulator.hash.update("]")
  return {
    source: accumulator.source,
    linkId: accumulator.linkId,
    effectiveCount: accumulator.effectiveCount,
    fingerprint: accumulator.hash.digest("hex"),
  }
}

function assertPageRows(value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new MaterializationValidationError("Materialization page size must be positive.")
}

function materializationChunkRows(
  chunk: import("../materializations").MaterializationPlanChunk
): number {
  return (
    chunk.overrides.objectUpserts.length +
    chunk.overrides.objectDeletes.length +
    chunk.overrides.linkUpserts.length +
    chunk.overrides.linkDeletes.length +
    chunk.effective.objectUpserts.length +
    chunk.effective.objectDeletes.length +
    chunk.effective.linkUpserts.length +
    chunk.effective.linkDeletes.length +
    chunk.timeseries.pointUpserts.length +
    chunk.outbox.length
  )
}

function materializationPlanItems(
  chunk: import("../materializations").MaterializationPlanChunk
): import("../materializations").MaterializationPlanWorkItem[] {
  return [
    ...chunk.overrides.objectUpserts.map((value) => ({
      kind: "object-override-upsert" as const,
      value,
    })),
    ...chunk.overrides.objectDeletes.map((value) => ({
      kind: "object-override-delete" as const,
      value,
    })),
    ...chunk.overrides.linkUpserts.map((value) => ({
      kind: "link-override-upsert" as const,
      value,
    })),
    ...chunk.overrides.linkDeletes.map((value) => ({
      kind: "link-override-delete" as const,
      value,
    })),
    ...chunk.effective.linkDeletes.map((value) => ({ kind: "link-delete" as const, value })),
    ...chunk.effective.objectDeletes.map((value) => ({ kind: "object-delete" as const, value })),
    ...chunk.effective.objectUpserts.map((value) => ({ kind: "object-upsert" as const, value })),
    ...chunk.effective.linkUpserts.map((value) => ({ kind: "link-upsert" as const, value })),
    ...chunk.timeseries.pointUpserts.map((value) => ({ kind: "point-upsert" as const, value })),
  ]
}

function assertChunkSequence(
  session: SessionState,
  chunk: import("../materializations").MaterializationPlanChunk
): void {
  const planItems = materializationPlanItems(chunk)
  const applyStream = session.workStreams.apply
  const appliedStart = session.appliedPlanItems.length
  if (
    planItems.length > 0 &&
    (!applyStream.started || appliedStart + planItems.length > applyStream.emittedCount)
  ) {
    invalidCorrelation("Materialization plan items cannot be applied before they are streamed.")
  }
  for (let offset = 0; offset < planItems.length; offset += 1) {
    const expected = session.applyWork[appliedStart + offset]?.item
    if (!expected || stableJsonStringify(planItems[offset]) !== stableJsonStringify(expected)) {
      invalidCorrelation("Materialization plan items must be applied in exact streamed order.")
    }
  }

  const eventStream = session.workStreams.event
  if (
    chunk.outbox.length > 0 &&
    (!eventStream.started || session.outboxCount + chunk.outbox.length > eventStream.emittedCount)
  ) {
    invalidCorrelation("Materialization events cannot be applied before they are streamed.")
  }
  for (let offset = 0; offset < chunk.outbox.length; offset += 1) {
    const expected = session.eventWork[session.outboxCount + offset]
    const actual = chunk.outbox[offset]?.envelope
    if (!expected || !actual) {
      invalidCorrelation("Materialization outbox events must follow exact streamed order.")
    }
    const { id: _id, commitOrdinal, ...actualDraft } = actual
    if (
      commitOrdinal !== session.outboxCount + offset ||
      stableJsonStringify(actualDraft) !== stableJsonStringify(expected.draft)
    ) {
      invalidCorrelation("Materialization outbox events must follow exact streamed order.")
    }
  }
}

function assertTimestamp(value: string, label: string): void {
  if (!Number.isFinite(Date.parse(value))) {
    throw new MaterializationValidationError(`${label} must be a valid timestamp.`)
  }
}

function assertLastCommit(
  value: StoredObjectOverride | StoredLinkOverride | undefined,
  expected: string | null,
  label: string
): void {
  if ((value?.lastCommitId ?? null) !== expected)
    throw new MaterializationConflictError("effective-state", `Expected ${label} changed.`)
}

function uniqueBy<T>(values: readonly T[], keyOf: (value: T) => string): T[] {
  return [...new Map(values.map((value) => [keyOf(value), structuredClone(value)])).values()]
}

function objectSnapshot(row: ObjectRow): EffectiveObjectSnapshot {
  if (!row.lastCommitId)
    throw new MaterializationConflictError(
      "effective-state",
      `Effective object ${row.objectTypeId}:${row.primaryId} lacks materializer provenance.`
    )
  return {
    ref: { objectTypeId: row.objectTypeId, primaryId: row.primaryId },
    properties: structuredClone(row.properties) as EffectiveObjectSnapshot["properties"],
    version: row.version,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    lastCommitId: row.lastCommitId,
  }
}

function linkSnapshot(row: ObjectLinkRow): EffectiveLinkSnapshot {
  if (!row.lastCommitId)
    throw new MaterializationConflictError(
      "effective-state",
      `Effective link lacks materializer provenance.`
    )
  return {
    ref: linkRef(row),
    ...(row.properties
      ? { properties: structuredClone(row.properties) as EffectiveLinkSnapshot["properties"] }
      : {}),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    lastCommitId: row.lastCommitId,
  }
}

function linkRef(row: ObjectLinkRow): OntologyLinkRef {
  return {
    source: { objectTypeId: row.sourceTypeId, primaryId: row.sourceId },
    linkId: row.linkId,
    target: { objectTypeId: row.targetTypeId, primaryId: row.targetId },
  }
}

function storedPoint(point: TimeseriesPoint): StoredTelemetryPoint {
  if (!point.lastCommitId)
    throw new MaterializationConflictError(
      "timeseries-point",
      "Telemetry point lacks materializer provenance."
    )
  return {
    series: {
      object: { objectTypeId: point.objectTypeId, primaryId: point.objectId },
      propertyId: point.propertyId,
    },
    value: structuredClone(point.value) as StoredTelemetryPoint["value"],
    ...(point.unit !== undefined ? { unit: point.unit } : {}),
    at: point.at.toISOString(),
    lastCommitId: point.lastCommitId,
  }
}

function findActiveSourceMaterialization(
  state: InMemoryOntologyState,
  projectId: string,
  sourceId: string
): InMemorySourceMaterialization | undefined {
  let active: InMemorySourceMaterialization | undefined
  for (const materialization of state.sourceMaterializations.values()) {
    if (
      materialization.projectId !== projectId ||
      materialization.source.projectionId !== sourceId ||
      materialization.status !== "active"
    ) {
      continue
    }
    if (active) {
      throw new MaterializationConflictError(
        "source-materialization",
        `Source '${sourceId}' has more than one active materialization.`
      )
    }
    active = materialization
  }
  return active
}

function storedSource(
  sourceId: string,
  materializationId: string,
  row: StageSourceAssertion
): StoredSourceAssertion {
  return {
    source: { projectionId: sourceId },
    materializationId,
    root: structuredClone(row.root),
    assertion: structuredClone(row.assertion),
    stagingOrdinal: row.stagingOrdinal,
  } as StoredSourceAssertion
}

function storedSourceObject(
  sourceId: string,
  materializationId: string | undefined,
  row: StageSourceAssertion | undefined
): StoredSourceObjectAssertion | null {
  if (!materializationId || !row || row.assertion.kind !== "object") return null
  return storedSource(sourceId, materializationId, row) as StoredSourceObjectAssertion
}

function storedSourceLink(
  sourceId: string,
  materializationId: string | undefined,
  row: StageSourceAssertion | undefined
): StoredSourceLinkAssertion | null {
  if (!materializationId || !row || row.assertion.kind !== "link") return null
  return storedSource(sourceId, materializationId, row) as StoredSourceLinkAssertion
}

function addReplacementLink(
  replacement: ReplacementSessionState,
  ref: OntologyLinkRef,
  diffRequired: boolean
): void {
  const key = linkRefKey(ref)
  const existing = replacement.links.get(key)
  if (existing) {
    existing.diffRequired ||= diffRequired
    if (diffRequired) replacement.affectedScopes.add(linkScopeSortKey(ref.source, ref.linkId))
    return
  }
  replacement.links.set(key, {
    ref: structuredClone(ref),
    sortKey: linkRefSortKey(ref),
    diffRequired,
  })
  if (diffRequired) replacement.affectedScopes.add(linkScopeSortKey(ref.source, ref.linkId))
}

function selectBoundedUnique<T>(
  values: readonly T[],
  cursor: string | null,
  limit: number,
  sortKeyOf: (value: T) => string,
  identityOf: (value: T) => string
): T[] {
  const selected = new Map<string, T>()
  for (const value of values) {
    const sortKey = sortKeyOf(value)
    if (cursor !== null && sortKey <= cursor) continue
    const identity = identityOf(value)
    let duplicate = false
    for (const candidate of selected.values()) {
      if (identityOf(candidate) === identity) {
        duplicate = true
        break
      }
    }
    if (duplicate) continue
    selected.set(sortKey, value)
    if (selected.size <= limit) continue
    let largest: string | null = null
    for (const key of selected.keys()) if (largest === null || key > largest) largest = key
    if (largest !== null) selected.delete(largest)
  }
  return [...selected.entries()]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([, value]) => value)
}

function assertWorkRecord(
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
      stableJsonStringify(record.draft.actor ?? null) !==
        stableJsonStringify(header.commit.actor ?? null)
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

function workUniquenessKey(record: MaterializationWorkRecord): string {
  switch (record.kind) {
    case "classification":
      return `classification:${record.entityKind}:${record.identityKey}`
    case "object-existence":
      return `object-existence:${objectRefKey(record.ref)}`
    case "incident-object":
      return `incident-object:${objectRefKey(record.ref)}`
    case "cardinality":
      return `cardinality:${record.scopeSortKey}:${record.linkSortKey}`
    case "plan":
      return `plan:${record.item.kind}:${record.sortKey}`
    case "event":
      return `event:${record.eventKindRank}:${record.sortKey}`
  }
}

function comparePlanWork(
  left: MaterializationPlanWorkRecord,
  right: MaterializationPlanWorkRecord
): number {
  return (
    left.applyPhase - right.applyPhase ||
    planKindOrder(left.item.kind) - planKindOrder(right.item.kind) ||
    left.sortKey.localeCompare(right.sortKey) ||
    left.recordKey.localeCompare(right.recordKey)
  )
}

function planKindOrder(kind: MaterializationPlanWorkItem["kind"]): number {
  switch (kind) {
    case "object-override-upsert":
      return 0
    case "object-override-delete":
      return 1
    case "link-override-upsert":
      return 2
    case "link-override-delete":
      return 3
    case "point-upsert":
      return 4
    case "link-delete":
      return 5
    case "object-delete":
      return 6
    case "object-upsert":
      return 7
    case "link-upsert":
      return 8
  }
}

function compareCardinalityWork(
  left: MaterializationCardinalityOccupantWorkRecord,
  right: MaterializationCardinalityOccupantWorkRecord
): number {
  return (
    left.scopeSortKey.localeCompare(right.scopeSortKey) ||
    left.linkSortKey.localeCompare(right.linkSortKey) ||
    left.recordKey.localeCompare(right.recordKey)
  )
}

function compareEventWork(
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
  switch (record.item.kind) {
    case "object-override-upsert":
    case "object-override-delete":
    case "link-override-upsert":
    case "link-override-delete":
      return record.applyPhase === 0
    case "point-upsert":
      return record.applyPhase === 1
    case "link-delete":
      return record.applyPhase === 2
    case "object-delete":
      return record.applyPhase === 3
    case "object-upsert":
      return record.applyPhase === 4
    case "link-upsert":
      return record.applyPhase === 5
  }
}

function assertMaterializationHeader(header: MaterializationPlanHeader): void {
  const { commit } = header
  assertNonblank(commit.projectId, "Materialization project id")
  assertNonblank(commit.id, "Materialization commit id")
  assertNonblank(commit.idempotencyKey, "Materialization idempotency key")
  assertNonblank(commit.requestHash, "Materialization request hash")
  assertNonblank(commit.ontologyRevision, "Materialization ontology revision")
  assertTimestamp(commit.committedAt, "Materialization commit time")
  if (commit.intent.kind === "edit") {
    if (commit.origin.kind !== "action" && commit.origin.kind !== "runtime") {
      invalidCorrelation("Edit commit origin does not correlate with its intent.")
    }
    if (!Number.isSafeInteger(commit.intent.operationCount) || commit.intent.operationCount < 0) {
      invalidCorrelation("Edit commit operation count is invalid.")
    }
    if (commit.origin.kind === "action") {
      assertNonblank(commit.origin.actionId, "Action origin action id")
      assertNonblank(commit.origin.runId, "Action origin run id")
    } else {
      assertNonblank(commit.origin.requestId, "Runtime origin request id")
    }
  } else if (commit.intent.kind === "projection") {
    if (
      commit.origin.kind !== "projection" ||
      commit.origin.projectionId !== commit.intent.source.projectionId ||
      commit.origin.datasetId !== commit.intent.datasetVersion.datasetId ||
      commit.origin.datasetVersionId !== commit.intent.datasetVersion.versionId ||
      !commit.projectionRevision ||
      !commit.ownershipHash
    ) {
      invalidCorrelation("Projection commit metadata does not correlate with its intent.")
    }
    assertNonblank(commit.origin.projectionRunId, "Projection run id")
    assertTimestamp(commit.intent.datasetVersion.createdAt, "Projection dataset version createdAt")
  } else {
    if (commit.origin.kind !== "telemetry") {
      invalidCorrelation("Telemetry commit origin does not correlate with its intent.")
    }
    if (
      !Number.isSafeInteger(commit.intent.pointCount) ||
      commit.intent.pointCount < 0 ||
      !Number.isSafeInteger(commit.intent.inputPointCount) ||
      commit.intent.inputPointCount < commit.intent.pointCount
    ) {
      invalidCorrelation("Telemetry commit point counts are invalid.")
    }
    if (commit.intent.source.kind === "projection") {
      if (
        commit.origin.source.kind !== "projection" ||
        commit.intent.source.projection.projectionId !== commit.origin.source.projectionId ||
        commit.intent.source.datasetVersion.datasetId !== commit.origin.source.datasetId ||
        commit.intent.source.datasetVersion.versionId !== commit.origin.source.datasetVersionId ||
        commit.intent.source.batchOrdinal !== commit.origin.source.batchOrdinal ||
        !Number.isSafeInteger(commit.intent.source.batchOrdinal) ||
        commit.intent.source.batchOrdinal < 0 ||
        !Number.isSafeInteger(commit.intent.source.sourceRowCount) ||
        commit.intent.source.sourceRowCount <= 0 ||
        commit.intent.source.sourceRowCount < commit.intent.inputPointCount ||
        typeof commit.intent.source.inputExhausted !== "boolean" ||
        !commit.projectionRevision ||
        !commit.ownershipHash
      ) {
        invalidCorrelation("Projection telemetry metadata does not correlate with its intent.")
      }
      assertNonblank(commit.origin.source.projectionRunId, "Telemetry projection run id")
      assertTimestamp(
        commit.intent.source.datasetVersion.createdAt,
        "Telemetry dataset version createdAt"
      )
    } else if (
      commit.origin.source.kind !== "runtime" ||
      commit.projectionRevision !== undefined ||
      commit.ownershipHash !== undefined
    ) {
      invalidCorrelation("Runtime telemetry commit contains projection-only metadata.")
    }
  }
}

function assertPlanChunkCorrelations(
  chunk: import("../materializations").MaterializationPlanChunk,
  commit: MaterializationPlanHeader["commit"]
): void {
  for (const value of chunk.overrides.objectUpserts) {
    assertCommitWriteCorrelation(value.lastCommitId, value.updatedAt, commit, "Object override")
  }
  for (const value of chunk.overrides.linkUpserts) {
    assertCommitWriteCorrelation(value.lastCommitId, value.updatedAt, commit, "Link override")
  }
  for (const value of chunk.effective.objectUpserts) {
    assertObjectRefEqual(value.row.ref, value.expected.ref, "Effective object upsert")
    assertCommitWriteCorrelation(
      value.row.lastCommitId,
      value.row.updatedAt,
      commit,
      "Effective object"
    )
  }
  for (const value of chunk.effective.objectDeletes) {
    assertObjectRefEqual(value.ref, value.expected.ref, "Effective object delete")
  }
  for (const value of chunk.effective.linkUpserts) {
    assertLinkRefEqual(value.row.ref, value.expected.ref, "Effective link upsert")
    assertCommitWriteCorrelation(
      value.row.lastCommitId,
      value.row.updatedAt,
      commit,
      "Effective link"
    )
  }
  for (const value of chunk.effective.linkDeletes) {
    assertLinkRefEqual(value.ref, value.expected.ref, "Effective link delete")
  }
  for (const value of chunk.timeseries.pointUpserts) assertPointWriteCorrelation(value, commit)
  for (const value of chunk.outbox) assertOutboxCorrelation(value, commit)
}

function assertPlanItemCorrelation(
  item: import("../materializations").MaterializationPlanWorkItem,
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
  value: import("../materializations").ExactTimeseriesPointWrite,
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

function assertOutboxCorrelation(
  value: import("../outbox").OntologyOutboxWrite,
  commit: MaterializationPlanHeader["commit"]
): void {
  const { envelope } = value
  if (
    envelope.projectId !== commit.projectId ||
    envelope.commitId !== commit.id ||
    envelope.occurredAt !== commit.committedAt ||
    value.availableAt !== commit.committedAt ||
    value.createdAt !== commit.committedAt ||
    stableJsonStringify(envelope.origin) !== stableJsonStringify(commit.origin) ||
    stableJsonStringify(envelope.actor ?? null) !== stableJsonStringify(commit.actor ?? null) ||
    !Number.isSafeInteger(envelope.commitOrdinal) ||
    envelope.commitOrdinal < 0 ||
    envelope.id !== createEventId(commit.projectId, commit.id, envelope.commitOrdinal)
  ) {
    invalidCorrelation("Outbox event does not correlate with its materialization commit.")
  }
}

function assertFinalizationCorrelations(
  session: SessionState,
  finalization: import("../materializations").MaterializationPlanFinalization,
  state: InMemoryOntologyState,
  objects: InMemoryObjectStorage
): void {
  const { commit } = session.header
  const { result, sourceActivations } = finalization
  if (
    result.commitId !== commit.id ||
    result.kind !== commit.intent.kind ||
    result.created !== true ||
    !Number.isSafeInteger(result.eventCount) ||
    result.eventCount < 0 ||
    result.eventCount !== session.outboxCount
  ) {
    invalidCorrelation("Materialization result does not correlate with its commit intent.")
  }
  for (let ordinal = 0; ordinal < result.eventCount; ordinal += 1) {
    if (!session.outboxOrdinals.has(ordinal)) {
      invalidCorrelation("Outbox event ordinals must be contiguous from zero.")
    }
  }

  if (commit.intent.kind === "edit") {
    if (result.kind !== "edit" || result.outcomes.length !== commit.intent.operationCount) {
      invalidCorrelation("Edit result does not correlate with its operation count.")
    }
    if (sourceActivations.length !== 0) {
      invalidCorrelation("Edit materialization cannot activate a source materialization.")
    }
  } else if (commit.intent.kind === "projection") {
    if (result.kind !== "projection" || sourceActivations.length !== 1) {
      invalidCorrelation("Projection result requires exactly one correlated source activation.")
    }
  } else if (result.kind !== "telemetry" || sourceActivations.length !== 0) {
    invalidCorrelation("Telemetry result does not correlate with its point intent.")
  }

  for (const activation of sourceActivations) {
    assertSourceActivationCorrelation(activation, session, state)
  }
  if (sourceActivations[0]) {
    assertReplacementFullyStreamed(session, sourceActivations[0])
  }
  assertFinalizedWork(session, state, objects)
  if (commit.intent.kind === "projection") {
    if (result.kind !== "projection" || !projectionCountsCorrelate(session, result.counts)) {
      invalidCorrelation("Projection result counts do not correlate with finalized work.")
    }
  } else if (
    commit.intent.kind === "telemetry" &&
    (result.kind !== "telemetry" ||
      !telemetryCountsCorrelate(session, commit.intent.pointCount, result))
  ) {
    invalidCorrelation("Telemetry result counts do not correlate with finalized work.")
  }
}

function projectionCountsCorrelate(session: SessionState, actual: EffectiveChangeCounts): boolean {
  const expected = deriveExpectedProjectionCounts(session)
  if (expected === null) return false

  return effectiveChangeCountsMatch(actual, expected)
}

interface ClassifiedProjectionCounts {
  objects: number
  links: number
}

interface AppliedProjectionChangeCounts {
  objectsCreated: number
  objectsUpdated: number
  objectsDeleted: number
  linksCreated: number
  linksUpdated: number
  linksDeleted: number
}

const effectiveChangeCountKeys = [
  "objectsCreated",
  "objectsUpdated",
  "objectsDeleted",
  "objectsUnchanged",
  "linksCreated",
  "linksUpdated",
  "linksDeleted",
  "linksUnchanged",
] as const satisfies readonly (keyof EffectiveChangeCounts)[]

function deriveExpectedProjectionCounts(session: SessionState): EffectiveChangeCounts | null {
  const classified = countClassifiedProjectionEntities(session)
  const applied = countAppliedProjectionChanges(session)
  const objectsUnchanged = remainingClassifiedCount(
    classified.objects,
    applied.objectsCreated,
    applied.objectsUpdated,
    applied.objectsDeleted
  )
  const linksUnchanged = remainingClassifiedCount(
    classified.links,
    applied.linksCreated,
    applied.linksUpdated,
    applied.linksDeleted
  )

  if (objectsUnchanged < 0 || linksUnchanged < 0) return null

  return { ...applied, objectsUnchanged, linksUnchanged }
}

function countClassifiedProjectionEntities(session: SessionState): ClassifiedProjectionCounts {
  const counts = { objects: 0, links: 0 }

  for (const record of session.work.values()) {
    if (record.kind !== "classification") continue

    if (record.entityKind === "object") counts.objects += 1
    if (record.entityKind === "link") counts.links += 1
  }

  return counts
}

function countAppliedProjectionChanges(session: SessionState): AppliedProjectionChangeCounts {
  const counts: AppliedProjectionChangeCounts = {
    objectsCreated: 0,
    objectsUpdated: 0,
    objectsDeleted: 0,
    linksCreated: 0,
    linksUpdated: 0,
    linksDeleted: 0,
  }

  for (const work of session.applyWork) {
    const { item } = work

    switch (item.kind) {
      case "object-upsert":
        if (item.value.expected.exists) counts.objectsUpdated += 1
        else counts.objectsCreated += 1
        break
      case "object-delete":
        counts.objectsDeleted += 1
        break
      case "link-upsert":
        if (item.value.expected.exists) counts.linksUpdated += 1
        else counts.linksCreated += 1
        break
      case "link-delete":
        counts.linksDeleted += 1
        break
    }
  }

  return counts
}

function remainingClassifiedCount(
  classified: number,
  created: number,
  updated: number,
  deleted: number
): number {
  return classified - created - updated - deleted
}

function effectiveChangeCountsMatch(
  actual: EffectiveChangeCounts,
  expected: EffectiveChangeCounts
): boolean {
  return effectiveChangeCountKeys.every((key) => {
    const count = actual[key]
    return Number.isSafeInteger(count) && count >= 0 && count === expected[key]
  })
}

function telemetryCountsCorrelate(
  session: SessionState,
  pointCount: number,
  actual: TelemetryCommitResult
): boolean {
  let pointsCreated = 0
  let pointsUpdated = 0
  let latestObjectsChanged = 0
  for (const work of session.applyWork) {
    if (work.item.kind === "point-upsert") {
      if (work.item.value.expected.lastCommitId === null) pointsCreated += 1
      else pointsUpdated += 1
    } else if (work.item.kind === "object-upsert") {
      latestObjectsChanged += 1
    }
  }
  const expected = {
    pointsCreated,
    pointsUpdated,
    pointsUnchanged: pointCount - pointsCreated - pointsUpdated,
    latestObjectsChanged,
  }
  return (
    expected.pointsUnchanged >= 0 &&
    (Object.keys(expected) as (keyof typeof expected)[]).every(
      (key) =>
        Number.isSafeInteger(actual[key]) && actual[key] >= 0 && actual[key] === expected[key]
    )
  )
}

function assertSourceActivationCorrelation(
  activation: import("../materializations").SourceActivationWrite,
  session: SessionState,
  state: InMemoryOntologyState
): void {
  const { header } = session
  const { commit } = header
  if (
    commit.intent.kind !== "projection" ||
    commit.origin.kind !== "projection" ||
    activation.source.projectionId !== commit.intent.source.projectionId ||
    activation.source.projectionId !== commit.origin.projectionId ||
    activation.execution.projectionRunId !== commit.origin.projectionRunId ||
    activation.protocol !== "replacement" ||
    stableJsonStringify(activation.datasetVersion) !==
      stableJsonStringify(commit.intent.datasetVersion) ||
    activation.projectionRevision !== commit.projectionRevision ||
    activation.ownershipHash !== commit.ownershipHash ||
    activation.ontologyRevision !== commit.ontologyRevision ||
    activation.lastCommitId !== commit.id ||
    activation.updatedAt !== commit.committedAt ||
    !header.expected.sources.some(
      (expected) => stableJsonStringify(expected) === stableJsonStringify(activation.expected)
    )
  ) {
    invalidCorrelation("Source activation does not correlate with its projection commit.")
  }
  const candidate = state.sourceMaterializations.get(
    sourceMaterializationKey(
      commit.projectId,
      activation.source.projectionId,
      activation.materializationId
    )
  )
  if (!candidate || candidate.status !== "ready") {
    throw new MaterializationConflictError(
      "source-materialization",
      "Source activation candidate is missing or is not ready."
    )
  }
  if (
    candidate.projectionRunId !== activation.execution.projectionRunId ||
    candidate.executionToken !== activation.execution.executionToken ||
    candidate.projectionKind !== activation.projectionKind ||
    candidate.protocol !== activation.protocol ||
    stableJsonStringify(candidate.datasetVersion) !==
      stableJsonStringify(activation.datasetVersion) ||
    candidate.projectionRevision !== activation.projectionRevision ||
    candidate.ownershipHash !== activation.ownershipHash ||
    candidate.ontologyRevision !== activation.ontologyRevision
  ) {
    invalidCorrelation("Source activation does not match its ready candidate identity.")
  }
  if (candidate.readyAt === null) {
    invalidCorrelation("Source activation candidate has no ready timestamp.")
  }
  assertTimestampNotBefore(
    activation.updatedAt,
    candidate.readyAt,
    "Source activation cannot precede candidate readiness."
  )
  const previous = findActiveSourceMaterialization(
    state,
    commit.projectId,
    activation.source.projectionId
  )
  if (previous) {
    assertSourceDatasetWatermark(previous.datasetVersion, activation.datasetVersion)
    assertTimestampNotBefore(
      activation.updatedAt,
      previous.updatedAt,
      "Source activation cannot precede the active materialization update."
    )
  }
}

function assertSourceDatasetWatermark(
  active: PinnedDatasetVersion,
  next: PinnedDatasetVersion
): void {
  if (active.datasetId !== next.datasetId) {
    throw new MaterializationConflictError(
      "projection-fence",
      "Source activation dataset does not match the active source dataset."
    )
  }
  if (active.versionId === next.versionId && active.createdAt !== next.createdAt) {
    throw new MaterializationConflictError(
      "projection-fence",
      "Source activation reused an immutable dataset version id with different metadata."
    )
  }
  if (next.createdAt < active.createdAt) {
    throw new MaterializationConflictError(
      "projection-fence",
      "Source activation dataset version is older than the active watermark."
    )
  }
  if (next.createdAt === active.createdAt && next.versionId !== active.versionId) {
    throw new MaterializationConflictError(
      "projection-fence",
      "Source activation dataset watermark is ambiguous."
    )
  }
}

function assertFinalizedWork(
  session: SessionState,
  state: InMemoryOntologyState,
  objects: InMemoryObjectStorage
): void {
  const expectedPlanItems = session.applyWork.map((record) => stableJsonStringify(record.item))
  const appliedPlanItems = session.appliedPlanItems
  if (expectedPlanItems.length > 0 && !session.workStreams.apply.completed) {
    invalidCorrelation("Materialization plan work was not fully streamed.")
  }
  if (stableJsonStringify(appliedPlanItems) !== stableJsonStringify(expectedPlanItems)) {
    invalidCorrelation("Materialization plan work was not applied exactly once.")
  }
  if (session.cardinalityWork.length > 0 && !session.workStreams.cardinality.completed) {
    invalidCorrelation("Materialization cardinality work was not fully validated.")
  }
  assertFinalCardinality(session.cardinalityWork, session.header.commit.projectId, objects)
  if (session.header.commit.intent.kind === "telemetry") {
    const pointKeys = classificationKeys(session, "point")
    if (pointKeys.length !== session.header.commit.intent.pointCount) {
      invalidCorrelation(
        "Telemetry point classification coverage does not match the commit intent."
      )
    }
  }

  const expectedEvents = [...session.eventWork].sort(compareEventWork)
  if (expectedEvents.length > 0 && !session.workStreams.event.completed) {
    invalidCorrelation("Materialization event work was not fully drained.")
  }
  if (session.outboxEnvelopes.size !== expectedEvents.length) {
    invalidCorrelation("Materialization event work was not fully written to the outbox.")
  }
  for (let ordinal = 0; ordinal < expectedEvents.length; ordinal += 1) {
    const expected = expectedEvents[ordinal]
    const actual = session.outboxEnvelopes.get(ordinal)
    if (!expected || !actual) {
      invalidCorrelation("Materialization event work was not fully written to the outbox.")
    }
    const { id, commitOrdinal, ...actualDraft } = actual
    if (
      commitOrdinal !== ordinal ||
      id !== createEventId(session.header.commit.projectId, session.header.commit.id, ordinal) ||
      stableJsonStringify(actualDraft) !== stableJsonStringify(expected.draft)
    ) {
      invalidCorrelation("Materialization outbox event does not match its staged event work.")
    }
    const persisted = state.outbox.get(outboxKey(session.header.commit.projectId, actual.id))
    if (!persisted || stableJsonStringify(persisted.envelope) !== stableJsonStringify(actual)) {
      invalidCorrelation("Materialization outbox event was not persisted.")
    }
  }
}

function assertFinalCardinality(
  records: readonly MaterializationCardinalityOccupantWorkRecord[],
  projectId: string,
  objects: InMemoryObjectStorage
): void {
  const scopes = new Map<
    string,
    {
      readonly source: OntologyObjectRef
      readonly linkId: string
      readonly occupiedLinkKeys: Set<string>
    }
  >()
  let currentScope: string | null = null
  let occupiedCount = 0
  for (const record of records) {
    if (record.scopeSortKey !== currentScope) {
      currentScope = record.scopeSortKey
      occupiedCount = 0
    }
    const scope = scopes.get(record.scopeSortKey) ?? {
      source: structuredClone(record.ref.source),
      linkId: record.ref.linkId,
      occupiedLinkKeys: new Set<string>(),
    }
    scopes.set(record.scopeSortKey, scope)
    if (record.occupied) {
      occupiedCount += 1
      scope.occupiedLinkKeys.add(record.linkSortKey)
      if (occupiedCount > 1) {
        invalidCorrelation("Materialization cardinality work violates cardinality-one.")
      }
    }
  }

  const adapter = getInMemoryObjectMaterializerAdapter(objects)
  for (const scope of scopes.values()) {
    const effectiveLinkKeys: string[] = []
    adapter.visitExactScopeLinks(
      projectId,
      scope.source.objectTypeId,
      scope.source.primaryId,
      scope.linkId,
      (row) => effectiveLinkKeys.push(linkRefSortKey(linkRef(row)))
    )
    effectiveLinkKeys.sort()
    const occupiedLinkKeys = [...scope.occupiedLinkKeys].sort()
    if (stableJsonStringify(effectiveLinkKeys) !== stableJsonStringify(occupiedLinkKeys)) {
      invalidCorrelation(
        "Materialization cardinality work does not match the final effective link scope."
      )
    }
  }
}

function assertReplacementFullyStreamed(
  session: SessionState,
  activation: import("../materializations").SourceActivationWrite
): void {
  const replacement = session.replacement
  if (
    !replacement ||
    replacement.sourceId !== activation.source.projectionId ||
    replacement.candidateMaterializationId !== activation.materializationId ||
    replacement.candidate.materializationId !== activation.materializationId ||
    replacement.candidate.projectionKind !== activation.projectionKind ||
    replacement.candidate.protocol !== activation.protocol
  ) {
    invalidCorrelation(
      "Source activation does not match the replacement candidate opened by the session."
    )
  }
  if (
    activation.projectionKind === "object" &&
    (!replacement.objectStreamCompleted || !replacement.linkStreamCompleted)
  ) {
    invalidCorrelation("Object projection replacement state was not fully streamed.")
  }
  if (activation.projectionKind === "link" && !replacement.linkStreamCompleted) {
    invalidCorrelation("Link projection replacement state was not fully streamed.")
  }
  const expectedObjectKeys =
    activation.projectionKind === "object" ? [...replacement.objects.keys()].sort() : []
  const expectedLinkKeys = [...replacement.links.entries()]
    .filter(([, value]) => value.diffRequired)
    .map(([key]) => key)
    .sort()
  if (
    stableJsonStringify(classificationKeys(session, "object")) !==
      stableJsonStringify(expectedObjectKeys) ||
    stableJsonStringify(classificationKeys(session, "link")) !==
      stableJsonStringify(expectedLinkKeys) ||
    classificationKeys(session, "point").length > 0
  ) {
    invalidCorrelation(
      "Projection replacement classification coverage does not match its streamed state."
    )
  }
}

function classificationKeys(
  session: SessionState,
  entityKind: import("../materializations").MaterializationWorkEntityKind
): string[] {
  return [...session.work.values()]
    .filter(
      (record): record is import("../materializations").MaterializationClassificationWorkRecord =>
        record.kind === "classification" && record.entityKind === entityKind
    )
    .map((record) => record.identityKey)
    .sort()
}

function assertTimestampNotBefore(value: string, minimum: string, message: string): void {
  if (Date.parse(value) < Date.parse(minimum)) invalidCorrelation(message)
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

function assertNonblank(value: string, label: string): void {
  if (value.trim().length === 0) invalidCorrelation(`${label} must be nonblank.`)
}

function invalidCorrelation(message: string): never {
  throw new MaterializationValidationError(message)
}
