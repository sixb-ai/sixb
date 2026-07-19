import { stableJsonStringify } from "../json"
import type { OntologyRegistry } from "../ontology"
import type { ProjectionRegistry } from "../projections/registry"
import { isStorageSerializationFailure, type Storage } from "../storage"
import type {
  MaterializationEventWorkRecord,
  MaterializationLinkState,
  MaterializationObjectState,
  MaterializationPlanWorkItem,
  MaterializationPlanWorkRecord,
  MaterializationSession,
  MaterializationStatePage,
  OntologyCommitWrite,
  OntologyMaterializationStorage,
  OntologyOutboxWrite,
  OntologyStorage,
  SourceReplacementObjectState,
  StoredLinkOverride,
  StoredObjectOverride,
  StoredTelemetryPoint,
} from "../storage/ontology"
import { applyLinkEdit, applyObjectEdit } from "./apply-edits"
import { type MaterializationBatching, resolveMaterializationBatching } from "./batching"
import { buildMaterializationEventDrafts, sequenceMaterializationEvent } from "./build-events"
import { diffEffectiveLink, diffEffectiveObject } from "./diff-effective"
import { MaterializationConflictError, MaterializationValidationError } from "./errors"
import {
  createActionIdempotencyKey,
  createFixedCommitIdentity,
  createProjectionGenerationId,
  createProjectionIdempotencyKey,
  createProjectionTelemetryIdempotencyKey,
  createRuntimeIdempotencyKey,
  createRuntimeTelemetryIdempotencyKey,
  type FixedCommitIdentity,
} from "./identity"
import { oneStateRequest, stateRequestForOperation } from "./load-state"
import {
  normalizeOntologyEditCommit,
  normalizeProjectionSourceEntry,
  normalizeTelemetryAppend,
} from "./normalize"
import { type MaterializationPlanItem, planStream } from "./plan-stream"
import {
  linkRefKey,
  linkRefSortKey,
  linkScopeSortKey,
  objectRefKey,
  objectRefSortKey,
  telemetryPointKey,
  telemetryPointSortKey,
  utf8JsonByteLength,
} from "./refs"
import { resolveEffectiveLink, resolveEffectiveObject } from "./resolve-effective"
import type {
  EditCommitResult,
  EffectiveChangeCounts,
  EffectiveLinkChange,
  EffectiveObjectChange,
  LinkOverride,
  ObjectOverride,
  OntologyEditCommit,
  OntologyEditOperation,
  OntologyLinkRef,
  OntologyMaterializationOrigin,
  OntologyMaterializer as OntologyMaterializerContract,
  OntologyObjectRef,
  OntologyOperationOutcome,
  ProjectionCommitResult,
  ProjectionSourceEntry,
  ProjectionSourceReplacement,
  TelemetryAppend,
  TelemetryCommitResult,
} from "./types"
import {
  validateEffectiveObject,
  validateLinkAuthorityProperties,
  validateLinkRef,
  validateObjectAuthorityProperties,
  validateObjectPatchPropertyIds,
  validateObjectRef,
  validateTelemetryPoint,
} from "./validate-effective"

export type MaterializerStorage = Storage & { readonly ontology: OntologyStorage }

export interface OntologyMaterializerDependencies {
  readonly batching?: Partial<MaterializationBatching>
  readonly clock?: () => Date
  readonly generationId?: () => string
  readonly maxSerializationRetries?: number
  readonly onSerializationRetry?: (attempt: number, error: unknown) => void
  /** @internal Bounded-memory instrumentation for core semantic buffers. */
  readonly observeCoreBuffer?: (boundary: string, rows: number) => void
}

export class OntologyMaterializer implements OntologyMaterializerContract {
  readonly edits = { commit: (input: OntologyEditCommit) => this.commitEdits(input) }
  readonly projections = {
    replace: (input: ProjectionSourceReplacement) => this.replaceProjection(input),
  }
  readonly telemetry = { append: (input: TelemetryAppend) => this.appendTelemetry(input) }

  private readonly batching: MaterializationBatching
  private readonly clock: () => Date
  private readonly generationId: () => string
  private readonly maxSerializationRetries: number

  constructor(
    private readonly projectId: string,
    private readonly ontology: OntologyRegistry,
    private readonly projectionRegistry: ProjectionRegistry,
    private readonly storage: MaterializerStorage,
    private readonly dependencies: OntologyMaterializerDependencies = {}
  ) {
    if (projectId.trim().length === 0) {
      throw new MaterializationValidationError("Materializer project id must be nonblank.")
    }
    this.batching = resolveMaterializationBatching(dependencies.batching)
    this.clock = dependencies.clock ?? (() => new Date())
    this.generationId = dependencies.generationId ?? createProjectionGenerationId
    this.maxSerializationRetries = dependencies.maxSerializationRetries ?? 2
    if (!Number.isSafeInteger(this.maxSerializationRetries) || this.maxSerializationRetries < 0) {
      throw new MaterializationValidationError(
        "Materializer serialization retry count must be a nonnegative safe integer."
      )
    }
  }

  private async commitEdits(raw: OntologyEditCommit): Promise<EditCommitResult> {
    const input = normalizeOntologyEditCommit(raw)
    const idempotencyKey =
      input.source.kind === "action"
        ? createActionIdempotencyKey(input.source.runId)
        : createRuntimeIdempotencyKey(input.source.requestId)
    const identity = createFixedCommitIdentity({
      projectId: this.projectId,
      idempotencyKey,
      normalizedCallerIntent: input,
      now: this.clock(),
    })
    const replay = await this.replay<EditCommitResult>(identity)
    if (replay) {
      if (input.source.kind === "action") {
        await this.attachRunReplay("action", input.source.runId, identity.commitId)
      }
      return replay
    }
    const origin: OntologyMaterializationOrigin = input.source

    return this.withSerializationRetry(async () =>
      this.storage.transaction(
        async (txBase) => {
          const tx = requireOntologyStorage(txBase)
          const replayInTransaction = await this.replay<EditCommitResult>(identity, tx)
          if (replayInTransaction) {
            if (input.source.kind === "action") {
              await attachRunReplay(
                tx,
                this.projectId,
                "action",
                input.source.runId,
                identity.commitId
              )
            }
            return replayInTransaction
          }
          const expected =
            input.mode === "atomic"
              ? {
                  objects: input.expectedObjects,
                  links: input.expectedLinks,
                  linkScopes: input.expectedLinkScopes,
                }
              : { objects: [], links: [], linkScopes: [] }
          const commit: OntologyCommitWrite = {
            projectId: this.projectId,
            id: identity.commitId,
            idempotencyKey: identity.idempotencyKey,
            requestHash: identity.requestHash,
            origin,
            ...(input.actor !== undefined ? { actor: input.actor } : {}),
            ontologyRevision: this.projectionRegistry.ontologyRevision,
            intent: { kind: "edit", mode: input.mode, operationCount: input.operations.length },
            committedAt: identity.committedAt,
          }
          const session = await tx.ontology.materializations.begin({
            commit,
            expected: {
              ontologyRevision: this.projectionRegistry.ontologyRevision,
              sources: [],
              objects: expected.objects,
              links: expected.links,
              linkScopes: expected.linkScopes,
              points: [],
            },
          })

          const objects = new Map<string, WorkingObject>()
          const links = new Map<string, WorkingLink>()
          const scopeSnapshots = new Map<
            string,
            import("../storage/ontology").MaterializationLinkScopeState
          >()
          const outcomes: OntologyOperationOutcome[] = []

          for (const operation of input.operations) {
            try {
              if (operation.kind.startsWith("object.")) {
                validateObjectRef(this.ontology, (operation as ObjectOperation).ref)
              } else {
                validateLinkRef(this.ontology, (operation as LinkOperation).ref)
              }
              const requested = stateRequestForOperation(operation)
              const requestedLink = requested.links[0]
              const linkDefinition = requestedLink
                ? this.ontology
                    .resolveObjectType(requestedLink.source.objectTypeId)
                    .links.find((candidate) => candidate.id === requestedLink.linkId)
                : null
              const request = {
                ...requested,
                objects: requested.objects.filter((ref) => !objects.has(objectRefKey(ref))),
                links: requested.links.filter((ref) => !links.has(linkRefKey(ref))),
                linkScopes: requested.linkScopes.filter(
                  (scope) =>
                    linkDefinition?.cardinality === "one" &&
                    !scopeSnapshots.has(scopeKey(scope.source, scope.linkId))
                ),
              }
              const state = await this.loadState(tx.ontology.materializations, session, request)
              mergeWorkingState(objects, links, scopeSnapshots, state)
              if (operation.kind.startsWith("object.")) {
                const objectOperation = operation as ObjectOperation
                const working = objects.get(objectRefKey(objectOperation.ref))
                if (!working)
                  throw new MaterializationValidationError("Object state was not loaded.")
                const normalizedProperties =
                  objectOperation.kind === "object.create" ||
                  objectOperation.kind === "object.upsert"
                    ? validateObjectAuthorityProperties(
                        this.ontology,
                        objectOperation.ref,
                        objectOperation.properties
                      )
                    : undefined
                const normalizedSet =
                  objectOperation.kind === "object.patch"
                    ? validateObjectAuthorityProperties(
                        this.ontology,
                        objectOperation.ref,
                        objectOperation.set
                      )
                    : undefined
                if (objectOperation.kind === "object.patch") {
                  validateObjectPatchPropertyIds(
                    this.ontology,
                    objectOperation.ref,
                    objectOperation.unset,
                    "unset"
                  )
                  validateObjectPatchPropertyIds(
                    this.ontology,
                    objectOperation.ref,
                    objectOperation.reset,
                    "reset"
                  )
                }
                const currentEffective = this.resolveObject(working)
                const transition = applyObjectEdit({
                  operation: objectOperation,
                  sourceProperties: working.source?.assertion.properties ?? null,
                  authority: working.override,
                  effective: currentEffective
                    ? provisionalObjectSnapshot(working, currentEffective, identity)
                    : null,
                  ...(normalizedProperties !== undefined ? { normalizedProperties } : {}),
                  ...(normalizedSet !== undefined ? { normalizedSet } : {}),
                })
                const previous = working.override
                working.override = transition.next
                try {
                  const resolved = this.resolveObject(working)
                  if (Boolean(currentEffective) !== Boolean(resolved)) {
                    for await (const incidentPage of tx.ontology.materializations.streamState({
                      session,
                      requests: oneStateRequest({
                        objects: [],
                        links: [],
                        linkScopes: [],
                        incidentObjects: [objectOperation.ref],
                        points: [],
                      }),
                      pageRows: this.batching.statePageRows,
                    })) {
                      await this.mergeIncidentLinks(
                        tx.ontology.materializations,
                        session,
                        objects,
                        links,
                        incidentPage
                      )
                      const missingScopes = distinctCardinalityOneScopes(
                        this.ontology,
                        incidentPage.links.filter((state) => links.has(linkRefKey(state.ref))),
                        scopeSnapshots
                      )
                      if (missingScopes.length > 0) {
                        const scopeState = await this.loadState(
                          tx.ontology.materializations,
                          session,
                          {
                            objects: [],
                            links: [],
                            linkScopes: missingScopes,
                            incidentObjects: [],
                            points: [],
                          }
                        )
                        mergeWorkingState(objects, links, scopeSnapshots, scopeState)
                      }
                    }
                  }
                  if (resolved)
                    validateEffectiveObject(this.ontology, resolved.ref, resolved.properties)
                  this.validateWorkingCardinality(objects, links, scopeSnapshots)
                } catch (error) {
                  working.override = previous
                  throw error
                }
                const stepObject = this.resolveObject(working)
                outcomes.push({
                  id: operation.id,
                  ok: true,
                  authority: transition.changed ? "changed" : "unchanged",
                  ...(stepObject
                    ? { object: resultingObjectSnapshot(working, stepObject, identity) }
                    : {}),
                })
              } else {
                const linkOperation = operation as LinkOperation
                const working = links.get(linkRefKey(linkOperation.ref))
                if (!working) throw new MaterializationValidationError("Link state was not loaded.")
                const sourceEndpoint = objects.get(objectRefKey(linkOperation.ref.source))
                const targetEndpoint = objects.get(objectRefKey(linkOperation.ref.target))
                if (
                  linkOperation.kind === "link.upsert" &&
                  (!sourceEndpoint ||
                    !targetEndpoint ||
                    !this.resolveObject(sourceEndpoint) ||
                    !this.resolveObject(targetEndpoint))
                ) {
                  throw new MaterializationValidationError(
                    "Link upsert requires both endpoints to be effective."
                  )
                }
                const normalizedProperties =
                  linkOperation.kind === "link.upsert"
                    ? validateLinkAuthorityProperties(
                        this.ontology,
                        linkOperation.ref,
                        linkOperation.properties
                      )
                    : undefined
                const transition = applyLinkEdit({
                  operation: linkOperation,
                  hasSource: working.source !== null,
                  authority: working.override,
                  effective: this.resolveLink(working, objects)
                    ? provisionalLinkSnapshot(
                        working,
                        this.resolveLink(working, objects)!,
                        identity
                      )
                    : null,
                  ...(normalizedProperties !== undefined ? { normalizedProperties } : {}),
                })
                const previous = working.override
                working.override = transition.next
                try {
                  if (linkDefinition?.cardinality === "one") {
                    this.validateWorkingCardinality(objects, links, scopeSnapshots)
                  }
                } catch (error) {
                  working.override = previous
                  throw error
                }
                outcomes.push({
                  id: operation.id,
                  ok: true,
                  authority: transition.changed ? "changed" : "unchanged",
                })
              }
            } catch (error) {
              if (input.mode === "atomic" || !(error instanceof MaterializationValidationError)) {
                throw error
              }
              outcomes.push({
                id: operation.id,
                ok: false,
                error: {
                  code: "validation",
                  message: error.message,
                },
              })
            }
          }

          const objectChanges: EffectiveObjectChange[] = []
          const linkChanges: EffectiveLinkChange[] = []
          this.validateWorkingCardinality(objects, links, scopeSnapshots)
          for (const working of [...objects.values()].sort((a, b) => {
            const left = objectRefSortKey(a.ref)
            const right = objectRefSortKey(b.ref)
            return left < right ? -1 : left > right ? 1 : 0
          })) {
            const items: MaterializationPlanWorkItem[] = []
            appendObjectOverridePlan(items, working, identity)
            const resolved = this.resolveObject(working)
            if (resolved) validateEffectiveObject(this.ontology, resolved.ref, resolved.properties)
            const change = diffEffectiveObject({
              before: working.before,
              resolved,
              commitId: identity.commitId,
              committedAt: identity.committedAt,
            })
            if (change) {
              objectChanges.push(change)
              appendObjectEffectivePlan(items, change)
            }
            const sortKey = objectRefSortKey(working.ref)
            const work: import("../storage/ontology").MaterializationWorkRecord[] = [
              classificationWork("object", objectRefKey(working.ref), sortKey),
              ...items.map((item) => planWork(item, sortKey)),
            ]
            if (change) {
              work.push(
                ...eventWork(
                  buildMaterializationEventDrafts({
                    projectId: this.projectId,
                    commitId: identity.commitId,
                    committedAt: identity.committedAt,
                    origin,
                    ...(input.actor !== undefined ? { actor: input.actor } : {}),
                    objects: [change],
                    links: [],
                    points: [],
                  })[0]
                )
              )
            }
            await this.stageWorkBounded(tx.ontology.materializations, session, work)
          }
          for (const working of [...links.values()].sort((a, b) => {
            const left = linkRefSortKey(a.ref)
            const right = linkRefSortKey(b.ref)
            return left < right ? -1 : left > right ? 1 : 0
          })) {
            const items: MaterializationPlanWorkItem[] = []
            appendLinkOverridePlan(items, working, identity)
            const resolved = this.resolveLink(working, objects)
            const change = diffEffectiveLink({
              before: working.before,
              resolved,
              commitId: identity.commitId,
              committedAt: identity.committedAt,
            })
            if (change) {
              linkChanges.push(change)
              appendLinkEffectivePlan(items, change)
            }
            const sortKey = linkRefSortKey(working.ref)
            const work: import("../storage/ontology").MaterializationWorkRecord[] = [
              classificationWork("link", linkRefKey(working.ref), sortKey),
              ...items.map((item) => planWork(item, sortKey)),
            ]
            if (change) {
              work.push(
                ...eventWork(
                  buildMaterializationEventDrafts({
                    projectId: this.projectId,
                    commitId: identity.commitId,
                    committedAt: identity.committedAt,
                    origin,
                    ...(input.actor !== undefined ? { actor: input.actor } : {}),
                    objects: [],
                    links: [change],
                    points: [],
                  })[0]
                )
              )
            }
            await this.stageWorkBounded(tx.ontology.materializations, session, work)
          }

          await this.drainStagedWork(tx.ontology.materializations, session)
          const eventCount = await this.drainStagedEvents(
            tx.ontology.materializations,
            session,
            identity
          )

          const result: EditCommitResult = {
            kind: "edit",
            commitId: identity.commitId,
            created: true,
            eventCount,
            outcomes,
            changes: { objects: objectChanges, links: linkChanges },
          }
          const applied = await tx.ontology.materializations.finalize({
            session,
            finalization: {
              sourceActivations: [],
              result,
              ...(input.source.kind === "action"
                ? {
                    bookkeeping: {
                      kind: "action" as const,
                      actionId: input.source.actionId,
                      runId: input.source.runId,
                      commitId: identity.commitId,
                    },
                  }
                : {}),
            },
          })
          return applied.commit.result as EditCommitResult
        },
        { isolation: "serializable" }
      )
    )
  }

  private async replaceProjection(
    raw: ProjectionSourceReplacement
  ): Promise<ProjectionCommitResult> {
    const resolved = this.projectionRegistry.resolveSource(raw.source.projectionId)
    if (raw.datasetVersion.datasetId !== resolved.datasetId) {
      throw new MaterializationValidationError(
        `Projection '${resolved.projectionId}' requires dataset '${resolved.datasetId}'.`
      )
    }
    const datasetVersion = normalizeTelemetryAppend({
      source: {
        kind: "projection",
        projection: raw.source,
        datasetVersion: raw.datasetVersion,
        projectionRunId: raw.projectionRunId,
        batchOrdinal: 0,
      },
      points: [],
    }).source
    if (datasetVersion.kind !== "projection") {
      throw new MaterializationValidationError(
        "Projection replacement normalization produced an invalid source kind."
      )
    }
    const idempotencyKey = createProjectionIdempotencyKey(
      raw.source,
      datasetVersion.datasetVersion,
      resolved.projectionRevision
    )
    const identity = createFixedCommitIdentity({
      projectId: this.projectId,
      idempotencyKey,
      normalizedCallerIntent: {
        source: raw.source,
        datasetVersion: datasetVersion.datasetVersion,
      },
      now: this.clock(),
    })
    await bestEffort(() =>
      this.storage.ontology.sources.cleanupInactive({
        projectId: this.projectId,
        olderThan: inactiveGenerationCleanupCutoff(identity.committedAt),
        limit: this.batching.sourceStageRows,
      })
    )
    const replay = await this.replay<ProjectionCommitResult>(identity)
    if (replay) {
      await this.attachRunReplay("projection", raw.projectionRunId, identity.commitId)
      return replay
    }

    const active = await this.storage.ontology.sources.getActive({
      projectId: this.projectId,
      source: raw.source,
    })
    validateProjectionWatermark(active, datasetVersion.datasetVersion)
    const expectedSource = {
      source: raw.source,
      activeGenerationId: active?.activeGenerationId ?? null,
      lastCommitId: active?.lastCommitId ?? null,
    }
    const generationId = this.generationId()
    const stagedAt = identity.committedAt
    let stagedRootCount = 0
    let stagedAssertionCount = 0
    let staged = false
    try {
      await this.storage.ontology.sources.stage({
        projectId: this.projectId,
        source: raw.source,
        generationId,
        stagedAt,
        rows: [],
      })
      staged = true
      let rows: import("../storage/ontology").StageSourceAssertion[] = []
      let bytes = 0
      const flush = async () => {
        if (rows.length === 0) return
        await this.storage.ontology.sources.stage({
          projectId: this.projectId,
          source: raw.source,
          generationId,
          stagedAt,
          rows,
        })
        rows = []
        bytes = 0
      }
      for await (const rawEntry of raw.entries) {
        throwIfAborted(raw.signal)
        const entry = this.validateProjectionEntry(
          normalizeProjectionSourceEntry(rawEntry),
          resolved
        )
        const ordinal = stagedRootCount
        for (const assertion of entry.assertions) {
          const row = { root: entry.root, assertion, stagingOrdinal: ordinal }
          const rowBytes = utf8JsonByteLength(row)
          if (
            rows.length > 0 &&
            (rows.length >= this.batching.sourceStageRows ||
              bytes + rowBytes > this.batching.sourceStageBytes)
          )
            await flush()
          rows.push(row)
          bytes += rowBytes
          stagedAssertionCount += 1
        }
        stagedRootCount += 1
      }
      throwIfAborted(raw.signal)
      await flush()

      const result = await this.withSerializationRetry(async () =>
        this.storage.transaction(
          async (txBase) => {
            const tx = requireOntologyStorage(txBase)
            const replayInTransaction = await this.replay<ProjectionCommitResult>(identity, tx)
            if (replayInTransaction) {
              await attachRunReplay(
                tx,
                this.projectId,
                "projection",
                raw.projectionRunId,
                identity.commitId
              )
              return replayInTransaction
            }
            const origin: OntologyMaterializationOrigin = {
              kind: "projection",
              projectionId: resolved.projectionId,
              projectionRunId: raw.projectionRunId,
              datasetId: datasetVersion.datasetVersion.datasetId,
              datasetVersionId: datasetVersion.datasetVersion.versionId,
            }
            const commit: OntologyCommitWrite = {
              projectId: this.projectId,
              id: identity.commitId,
              idempotencyKey: identity.idempotencyKey,
              requestHash: identity.requestHash,
              origin,
              ontologyRevision: this.projectionRegistry.ontologyRevision,
              projectionRevision: resolved.projectionRevision,
              ownershipHash: resolved.ownershipHash,
              intent: {
                kind: "projection",
                source: raw.source,
                datasetVersion: datasetVersion.datasetVersion,
              },
              committedAt: identity.committedAt,
            }
            throwIfAborted(raw.signal)
            const session = await tx.ontology.materializations.begin({
              commit,
              expected: {
                ontologyRevision: this.projectionRegistry.ontologyRevision,
                sources: [expectedSource],
                objects: [],
                links: [],
                linkScopes: [],
                points: [],
              },
            })
            const counts = emptyCounts()
            for await (const page of tx.ontology.materializations.streamSourceReplacementState({
              session,
              source: raw.source,
              candidateGenerationId: generationId,
              entityKind: "object",
              pageRows: this.batching.statePageRows,
            })) {
              throwIfAborted(raw.signal)
              const work: import("../storage/ontology").MaterializationWorkRecord[] = []
              for (const state of page.objects) {
                const resolvedValue = this.resolveReplacementObject(state)
                if (resolvedValue) {
                  validateEffectiveObject(
                    this.ontology,
                    resolvedValue.ref,
                    resolvedValue.properties
                  )
                }
                const change = diffEffectiveObject({
                  before: state.effective,
                  resolved: resolvedValue,
                  commitId: identity.commitId,
                  committedAt: identity.committedAt,
                })
                const sortKey = objectRefSortKey(state.ref)
                work.push(classificationWork("object", objectRefKey(state.ref), sortKey))
                work.push({
                  kind: "object-existence",
                  recordKey: `existence:${sortKey}`,
                  ref: state.ref,
                  exists: resolvedValue !== null,
                })
                if (Boolean(state.effective) !== Boolean(resolvedValue)) {
                  work.push({
                    kind: "incident-object",
                    recordKey: `incident:${sortKey}`,
                    ref: state.ref,
                  })
                }
                if (change) {
                  incrementObjectCount(counts, change.kind)
                  const items: MaterializationPlanWorkItem[] = []
                  appendObjectEffectivePlan(items, change)
                  for (const item of items) work.push(planWork(item, sortKey))
                  work.push(
                    ...eventWork(
                      buildMaterializationEventDrafts({
                        projectId: this.projectId,
                        commitId: identity.commitId,
                        committedAt: identity.committedAt,
                        origin,
                        objects: [change],
                        links: [],
                        points: [],
                      })[0]
                    )
                  )
                } else {
                  counts.objectsUnchanged += 1
                }
              }
              await this.stageWorkBounded(tx.ontology.materializations, session, work)
            }

            for await (const page of tx.ontology.materializations.streamSourceReplacementState({
              session,
              source: raw.source,
              candidateGenerationId: generationId,
              entityKind: "link",
              pageRows: this.batching.statePageRows,
            })) {
              throwIfAborted(raw.signal)
              const endpointRefs = new Map<string, OntologyObjectRef>()
              for (const state of page.links) {
                endpointRefs.set(objectRefKey(state.ref.source), state.ref.source)
                endpointRefs.set(objectRefKey(state.ref.target), state.ref.target)
              }
              const endpointExistence = new Map<string, boolean>()
              for (const value of await tx.ontology.materializations.readObjectExistence({
                session,
                refs: [...endpointRefs.values()],
              })) {
                endpointExistence.set(objectRefKey(value.ref), value.exists)
              }
              const missingEndpoints = [...endpointRefs.values()].filter(
                (ref) => !endpointExistence.has(objectRefKey(ref))
              )
              if (missingEndpoints.length > 0) {
                for await (const endpointPage of tx.ontology.materializations.streamState({
                  session,
                  requests: oneStateRequest({
                    objects: missingEndpoints,
                    links: [],
                    linkScopes: [],
                    incidentObjects: [],
                    points: [],
                  }),
                  pageRows: this.batching.statePageRows,
                })) {
                  for (const endpoint of endpointPage.objects) {
                    endpointExistence.set(objectRefKey(endpoint.ref), endpoint.effective !== null)
                  }
                }
              }
              const work: import("../storage/ontology").MaterializationWorkRecord[] = []
              for (const state of page.links) {
                const resolvedValue = state.diffRequired
                  ? resolveEffectiveLink({
                      ref: state.ref,
                      source: state.candidateSource,
                      override: state.override?.value ?? null,
                      sourceEndpointExists:
                        endpointExistence.get(objectRefKey(state.ref.source)) ?? false,
                      targetEndpointExists:
                        endpointExistence.get(objectRefKey(state.ref.target)) ?? false,
                    })
                  : state.effective
                const definition = this.ontology
                  .resolveObjectType(state.ref.source.objectTypeId)
                  .links.find((candidate) => candidate.id === state.ref.linkId)
                if (definition?.cardinality === "one") {
                  const scopeSortKey = linkScopeSortKey(state.ref.source, state.ref.linkId)
                  const linkSortKey = linkRefSortKey(state.ref)
                  work.push({
                    kind: "cardinality",
                    recordKey: `cardinality:${scopeSortKey}:${linkSortKey}`,
                    scopeSortKey,
                    linkSortKey,
                    ref: state.ref,
                    occupied: resolvedValue !== null,
                  })
                }
                if (state.diffRequired) {
                  const change = diffEffectiveLink({
                    before: state.effective,
                    resolved: resolvedValue,
                    commitId: identity.commitId,
                    committedAt: identity.committedAt,
                  })
                  const sortKey = linkRefSortKey(state.ref)
                  work.push(classificationWork("link", linkRefKey(state.ref), sortKey))
                  if (change) {
                    incrementLinkCount(counts, change.kind)
                    const items: MaterializationPlanWorkItem[] = []
                    appendLinkEffectivePlan(items, change)
                    for (const item of items) work.push(planWork(item, sortKey))
                    work.push(
                      ...eventWork(
                        buildMaterializationEventDrafts({
                          projectId: this.projectId,
                          commitId: identity.commitId,
                          committedAt: identity.committedAt,
                          origin,
                          objects: [],
                          links: [change],
                          points: [],
                        })[0]
                      )
                    )
                  } else {
                    counts.linksUnchanged += 1
                  }
                }
              }
              await this.stageWorkBounded(tx.ontology.materializations, session, work)
            }

            await this.validateStagedCardinality(tx.ontology.materializations, session, raw.signal)
            await this.drainStagedWork(tx.ontology.materializations, session, raw.signal)
            const eventCount = await this.drainStagedEvents(
              tx.ontology.materializations,
              session,
              identity,
              raw.signal
            )
            const result: ProjectionCommitResult = {
              kind: "projection",
              commitId: identity.commitId,
              created: true,
              eventCount,
              counts,
            }
            throwIfAborted(raw.signal)
            const applied = await tx.ontology.materializations.finalize({
              session,
              finalization: {
                sourceActivations: [
                  {
                    source: raw.source,
                    generationId,
                    datasetVersion: datasetVersion.datasetVersion,
                    projectionRevision: resolved.projectionRevision,
                    ownershipHash: resolved.ownershipHash,
                    ontologyRevision: this.projectionRegistry.ontologyRevision,
                    expected: expectedSource,
                    lastCommitId: identity.commitId,
                    updatedAt: identity.committedAt,
                  },
                ],
                result,
                bookkeeping: {
                  kind: "projection",
                  protocol: "replacement",
                  projectionId: resolved.projectionId,
                  runId: raw.projectionRunId,
                  datasetVersion: datasetVersion.datasetVersion,
                  projectionRevision: resolved.projectionRevision,
                  commitId: identity.commitId,
                  stagedRootCount,
                  stagedAssertionCount,
                  counts,
                },
              },
            })
            throwIfAborted(raw.signal)
            return applied.commit.result as ProjectionCommitResult
          },
          { isolation: "serializable" }
        )
      )
      const activeAfterCommit = await this.storage.ontology.sources.getActive({
        projectId: this.projectId,
        source: raw.source,
      })
      if (activeAfterCommit?.activeGenerationId === generationId) {
        if (expectedSource.activeGenerationId) {
          await bestEffort(() =>
            this.storage.ontology.sources.discard({
              projectId: this.projectId,
              source: raw.source,
              generationId: expectedSource.activeGenerationId!,
            })
          )
        }
      } else {
        await bestEffort(() =>
          this.storage.ontology.sources.discard({
            projectId: this.projectId,
            source: raw.source,
            generationId,
          })
        )
      }
      return result
    } catch (error) {
      if (staged)
        await bestEffort(() =>
          this.storage.ontology.sources.discard({
            projectId: this.projectId,
            source: raw.source,
            generationId,
          })
        )
      throw error
    } finally {
      await bestEffort(() =>
        this.storage.ontology.sources.cleanupInactive({
          projectId: this.projectId,
          olderThan: inactiveGenerationCleanupCutoff(identity.committedAt),
          limit: this.batching.sourceStageRows,
        })
      )
    }
  }

  private async appendTelemetry(raw: TelemetryAppend): Promise<TelemetryCommitResult> {
    const input = normalizeTelemetryAppend(raw)
    const resolvedProjection =
      input.source.kind === "projection"
        ? this.projectionRegistry.resolveTelemetry(input.source.projection.projectionId)
        : null
    if (
      resolvedProjection &&
      input.source.kind === "projection" &&
      resolvedProjection.datasetId !== input.source.datasetVersion.datasetId
    ) {
      throw new MaterializationValidationError(
        `Telemetry projection '${resolvedProjection.projectionId}' requires dataset '${resolvedProjection.datasetId}'.`
      )
    }
    for (const point of input.points) validateTelemetryPoint(this.ontology, point)
    if (resolvedProjection) {
      const ownedSeries = new Set(
        resolvedProjection.ownership.telemetry.map(({ objectTypeId, propertyId }) =>
          JSON.stringify([objectTypeId, propertyId])
        )
      )
      for (const point of input.points) {
        const scope = JSON.stringify([point.series.object.objectTypeId, point.series.propertyId])
        if (!ownedSeries.has(scope)) {
          throw new MaterializationValidationError(
            `Telemetry projection '${resolvedProjection.projectionId}' does not own series '${point.series.object.objectTypeId}.${point.series.propertyId}'.`
          )
        }
      }
    }
    const idempotencyKey =
      input.source.kind === "runtime"
        ? createRuntimeTelemetryIdempotencyKey(input.source.requestId)
        : createProjectionTelemetryIdempotencyKey({
            source: input.source.projection,
            datasetVersion: input.source.datasetVersion,
            batchOrdinal: input.source.batchOrdinal,
          })
    const callerIntent =
      input.source.kind === "runtime"
        ? input
        : {
            ...input,
            source: {
              kind: "projection" as const,
              projection: input.source.projection,
              datasetVersion: input.source.datasetVersion,
              batchOrdinal: input.source.batchOrdinal,
            },
          }
    const identity = createFixedCommitIdentity({
      projectId: this.projectId,
      idempotencyKey,
      normalizedCallerIntent: callerIntent,
      now: this.clock(),
    })
    const replay = await this.replay<TelemetryCommitResult>(identity)
    if (replay) {
      if (input.source.kind === "projection") {
        await this.attachRunReplay("projection", input.source.projectionRunId, identity.commitId)
      }
      return replay
    }

    return this.withSerializationRetry(async () =>
      this.storage.transaction(
        async (txBase) => {
          const tx = requireOntologyStorage(txBase)
          const replayInTransaction = await this.replay<TelemetryCommitResult>(identity, tx)
          if (replayInTransaction) {
            if (input.source.kind === "projection") {
              await attachRunReplay(
                tx,
                this.projectId,
                "projection",
                input.source.projectionRunId,
                identity.commitId
              )
            }
            return replayInTransaction
          }
          const origin: OntologyMaterializationOrigin = {
            kind: "telemetry",
            source:
              input.source.kind === "runtime"
                ? input.source
                : {
                    kind: "projection",
                    projectionId: input.source.projection.projectionId,
                    projectionRunId: input.source.projectionRunId,
                    datasetId: input.source.datasetVersion.datasetId,
                    datasetVersionId: input.source.datasetVersion.versionId,
                    batchOrdinal: input.source.batchOrdinal,
                  },
          }
          const commit: OntologyCommitWrite = {
            projectId: this.projectId,
            id: identity.commitId,
            idempotencyKey: identity.idempotencyKey,
            requestHash: identity.requestHash,
            origin,
            ...(input.actor !== undefined ? { actor: input.actor } : {}),
            ontologyRevision: this.projectionRegistry.ontologyRevision,
            ...(resolvedProjection
              ? {
                  projectionRevision: resolvedProjection.projectionRevision,
                  ownershipHash: resolvedProjection.ownershipHash,
                }
              : {}),
            intent: {
              kind: "telemetry",
              pointCount: input.points.length,
              ...(input.source.kind === "projection"
                ? { batchOrdinal: input.source.batchOrdinal }
                : {}),
            },
            committedAt: identity.committedAt,
          }
          const session = await tx.ontology.materializations.begin({
            commit,
            expected: {
              ontologyRevision: this.projectionRegistry.ontologyRevision,
              sources: [],
              objects: [],
              links: [],
              linkScopes: [],
              points: [],
            },
          })
          let pointsCreated = 0
          let pointsUpdated = 0
          let pointsUnchanged = 0
          let latestObjectsChanged = 0
          let groupStart = 0
          while (groupStart < input.points.length) {
            const objectRef = input.points[groupStart].series.object
            const objectKey = objectRefKey(objectRef)
            let groupEnd = groupStart + 1
            while (
              groupEnd < input.points.length &&
              objectRefKey(input.points[groupEnd].series.object) === objectKey
            ) {
              groupEnd += 1
            }
            const objectState = await this.loadState(tx.ontology.materializations, session, {
              objects: [objectRef],
              links: [],
              linkScopes: [],
              incidentObjects: [],
              points: [],
            })
            const storedObject = objectState.objects[0]
            if (!storedObject) {
              throw new MaterializationValidationError("Telemetry object state was not loaded.")
            }
            const working = workingObjectFromState(storedObject)
            const latest = new Map(
              working.latestTelemetry.map((point) => [point.series.propertyId, point])
            )
            for (
              let chunkStart = groupStart;
              chunkStart < groupEnd;
              chunkStart += this.batching.statePageRows
            ) {
              const points = input.points.slice(
                chunkStart,
                Math.min(groupEnd, chunkStart + this.batching.statePageRows)
              )
              const existingPoints = new Map<string, StoredTelemetryPoint>()
              for await (const page of tx.ontology.materializations.streamState({
                session,
                requests: oneStateRequest({
                  objects: [],
                  links: [],
                  linkScopes: [],
                  incidentObjects: [],
                  points: points.map((point) => ({ series: point.series, at: point.at })),
                }),
                pageRows: this.batching.statePageRows,
              })) {
                for (const existing of page.points) {
                  existingPoints.set(telemetryPointKey(existing.series, existing.at), existing)
                }
              }
              this.dependencies.observeCoreBuffer?.(
                "telemetry.existing-points",
                existingPoints.size
              )
              const pointWork: import("../storage/ontology").MaterializationWorkRecord[] = []
              for (const point of points) {
                const identityKey = telemetryPointKey(point.series, point.at)
                const sortKey = telemetryPointSortKey(point.series, point.at)
                const existing = existingPoints.get(identityKey)
                const unchanged = Boolean(
                  existing &&
                    stableJsonStringify({ value: existing.value, unit: existing.unit ?? null }) ===
                      stableJsonStringify({ value: point.value, unit: point.unit ?? null })
                )
                pointWork.push(classificationWork("point", identityKey, sortKey))
                if (unchanged) {
                  pointsUnchanged += 1
                } else {
                  if (existing) pointsUpdated += 1
                  else pointsCreated += 1
                  const item: MaterializationPlanWorkItem = {
                    kind: "point-upsert",
                    value: {
                      point: {
                        series: point.series,
                        value: point.value,
                        ...(point.unit !== undefined ? { unit: point.unit } : {}),
                        at: point.at,
                        lastCommitId: identity.commitId,
                      },
                      expected: {
                        series: point.series,
                        at: point.at,
                        lastCommitId: existing?.lastCommitId ?? null,
                      },
                    },
                  }
                  pointWork.push(planWork(item, sortKey))
                  pointWork.push(
                    ...eventWork(
                      buildMaterializationEventDrafts({
                        projectId: this.projectId,
                        commitId: identity.commitId,
                        committedAt: identity.committedAt,
                        origin,
                        ...(input.actor !== undefined ? { actor: input.actor } : {}),
                        objects: [],
                        links: [],
                        points: [{ point }],
                      })[0]
                    )
                  )
                }
                const current = latest.get(point.series.propertyId)
                if (!current || point.at >= current.at) {
                  latest.set(point.series.propertyId, {
                    series: point.series,
                    value: point.value,
                    ...(point.unit !== undefined ? { unit: point.unit } : {}),
                    at: point.at,
                    lastCommitId: unchanged
                      ? (existing?.lastCommitId ?? identity.commitId)
                      : identity.commitId,
                  })
                }
              }
              await this.stageWorkBounded(tx.ontology.materializations, session, pointWork)
            }
            working.latestTelemetry = [...latest.values()]
            const resolved = this.resolveObject(working)
            if (resolved) validateEffectiveObject(this.ontology, resolved.ref, resolved.properties)
            const change = diffEffectiveObject({
              before: working.before,
              resolved,
              commitId: identity.commitId,
              committedAt: identity.committedAt,
            })
            const sortKey = objectRefSortKey(working.ref)
            const objectWork: import("../storage/ontology").MaterializationWorkRecord[] = [
              classificationWork("object", objectRefKey(working.ref), sortKey),
            ]
            if (change) {
              latestObjectsChanged += 1
              const items: MaterializationPlanWorkItem[] = []
              appendObjectEffectivePlan(items, change)
              objectWork.push(...items.map((item) => planWork(item, sortKey)))
              objectWork.push(
                ...eventWork(
                  buildMaterializationEventDrafts({
                    projectId: this.projectId,
                    commitId: identity.commitId,
                    committedAt: identity.committedAt,
                    origin,
                    ...(input.actor !== undefined ? { actor: input.actor } : {}),
                    objects: [change],
                    links: [],
                    points: [],
                  })[0]
                )
              )
            }
            await this.stageWorkBounded(tx.ontology.materializations, session, objectWork)
            groupStart = groupEnd
          }
          await this.drainStagedWork(tx.ontology.materializations, session)
          const eventCount = await this.drainStagedEvents(
            tx.ontology.materializations,
            session,
            identity
          )
          const result: TelemetryCommitResult = {
            kind: "telemetry",
            commitId: identity.commitId,
            created: true,
            eventCount,
            pointsCreated,
            pointsUpdated,
            pointsUnchanged,
            latestObjectsChanged,
          }
          const applied = await tx.ontology.materializations.finalize({
            session,
            finalization: {
              sourceActivations: [],
              result,
              ...(input.source.kind === "projection" && resolvedProjection
                ? {
                    bookkeeping: {
                      kind: "projection" as const,
                      protocol: "telemetry" as const,
                      projectionId: resolvedProjection.projectionId,
                      runId: input.source.projectionRunId,
                      datasetVersion: input.source.datasetVersion,
                      projectionRevision: resolvedProjection.projectionRevision,
                      commitId: identity.commitId,
                      batchOrdinal: input.source.batchOrdinal,
                      batchPointCount: input.points.length,
                      pointsCreated,
                      pointsUpdated,
                      pointsUnchanged,
                      latestObjectsChanged,
                    },
                  }
                : {}),
            },
          })
          return applied.commit.result as TelemetryCommitResult
        },
        { isolation: "serializable" }
      )
    )
  }

  private resolveObject(working: WorkingObject) {
    return resolveEffectiveObject({
      ref: working.ref,
      primaryPropertyId: this.ontology.getPrimaryPropertyId(working.ref.objectTypeId),
      source: working.source,
      override: working.override,
      latestTelemetry: working.latestTelemetry,
    })
  }

  private resolveLink(working: WorkingLink, objects: Map<string, WorkingObject>) {
    return resolveEffectiveLink({
      ref: working.ref,
      source: working.source,
      override: working.override,
      sourceEndpointExists: Boolean(
        objects.get(objectRefKey(working.ref.source)) &&
          this.resolveObject(objects.get(objectRefKey(working.ref.source))!)
      ),
      targetEndpointExists: Boolean(
        objects.get(objectRefKey(working.ref.target)) &&
          this.resolveObject(objects.get(objectRefKey(working.ref.target))!)
      ),
    })
  }

  private resolveReplacementObject(state: SourceReplacementObjectState) {
    return resolveEffectiveObject({
      ref: state.ref,
      primaryPropertyId: this.ontology.getPrimaryPropertyId(state.ref.objectTypeId),
      source: state.candidateSource,
      override: state.override?.value ?? null,
      latestTelemetry: state.latestTelemetry,
    })
  }

  private validateProjectionEntry(
    entry: ProjectionSourceEntry,
    resolved: ReturnType<ProjectionRegistry["resolveSource"]>
  ): ProjectionSourceEntry {
    const expectedRootKind =
      resolved.definition._tag === "ObjectProjectionDefinition" ? "object" : "link"
    if (entry.root.kind !== expectedRootKind) {
      throw new MaterializationValidationError(
        `Projection '${resolved.projectionId}' requires ${expectedRootKind === "object" ? "an object" : "a link"} root.`
      )
    }
    const ownedProperties = new Map(
      resolved.ownership.objects.map((object) => [object.objectTypeId, new Set(object.propertyIds)])
    )
    const ownedLinks = new Set(
      resolved.ownership.links.map((link) => JSON.stringify([link.sourceObjectTypeId, link.linkId]))
    )
    const assertions = entry.assertions.map((assertion) => {
      if (assertion.kind === "object") {
        if (
          resolved.definition._tag !== "ObjectProjectionDefinition" ||
          assertion.ref.objectTypeId !== resolved.definition.objectTypeId
        )
          throw new MaterializationValidationError(
            "Projection asserted an object outside its owned type."
          )
        const properties = validateObjectAuthorityProperties(
          this.ontology,
          assertion.ref,
          assertion.properties
        )
        const owned = ownedProperties.get(assertion.ref.objectTypeId) ?? new Set<string>()
        for (const propertyId of Object.keys(properties)) {
          if (!owned.has(propertyId)) {
            throw new MaterializationValidationError(
              `Projection '${resolved.projectionId}' asserted unowned property '${assertion.ref.objectTypeId}.${propertyId}'.`
            )
          }
        }
        return {
          ...assertion,
          properties,
        }
      }
      if (
        !ownedLinks.has(JSON.stringify([assertion.ref.source.objectTypeId, assertion.ref.linkId]))
      )
        throw new MaterializationValidationError(
          "Projection asserted a link outside its owned scope."
        )
      const expectedTargetTypeId =
        resolved.definition._tag === "LinkProjectionDefinition"
          ? resolved.definition.targetObjectTypeId
          : resolved.definition.links[assertion.ref.linkId]?.targetObjectTypeId
      if (expectedTargetTypeId !== assertion.ref.target.objectTypeId) {
        throw new MaterializationValidationError(
          `Projection '${resolved.projectionId}' asserted link target type '${assertion.ref.target.objectTypeId}' outside its mapping.`
        )
      }
      validateLinkAuthorityProperties(this.ontology, assertion.ref, assertion.properties)
      if (assertion.properties !== undefined) {
        throw new MaterializationValidationError(
          `Projection '${resolved.projectionId}' does not map link assertion properties.`
        )
      }
      return {
        ...assertion,
      }
    })
    return { root: entry.root, assertions }
  }

  private validateWorkingCardinality(
    objects: Map<string, WorkingObject>,
    links: Map<string, WorkingLink>,
    scopes: Map<string, import("../storage/ontology").MaterializationLinkScopeState>
  ): void {
    const effectiveByScope = new Map<string, number>()
    for (const [scope, snapshot] of scopes) effectiveByScope.set(scope, snapshot.effectiveCount)
    for (const working of links.values()) {
      const scope = scopeKey(working.ref.source, working.ref.linkId)
      if (!effectiveByScope.has(scope)) continue
      const before = working.before ? 1 : 0
      const after = this.resolveLink(working, objects) ? 1 : 0
      effectiveByScope.set(scope, (effectiveByScope.get(scope) ?? 0) + after - before)
    }
    for (const [scope, effectiveCount] of effectiveByScope) {
      if (effectiveCount <= 1) continue
      const [sourceType, , linkId] = JSON.parse(scope) as string[]
      const link = this.ontology
        .resolveObjectType(sourceType)
        .links.find((candidate) => candidate.id === linkId)
      if (link?.cardinality === "one")
        throw new MaterializationValidationError(
          `Link scope '${sourceType}.${linkId}' has cardinality one.`
        )
    }
  }

  private async mergeIncidentLinks(
    storage: OntologyMaterializationStorage,
    session: MaterializationSession,
    objects: Map<string, WorkingObject>,
    links: Map<string, WorkingLink>,
    page: MaterializationStatePage
  ): Promise<void> {
    const missingEndpoints = new Map<string, OntologyObjectRef>()
    for (const state of page.links) {
      for (const ref of [state.ref.source, state.ref.target]) {
        if (!objects.has(objectRefKey(ref))) missingEndpoints.set(objectRefKey(ref), ref)
      }
    }
    if (missingEndpoints.size > 0) {
      const endpointState = await this.loadState(storage, session, {
        objects: [...missingEndpoints.values()],
        links: [],
        linkScopes: [],
        incidentObjects: [],
        points: [],
      })
      mergeWorkingState(objects, new Map(), new Map(), endpointState)
    }
    for (const state of page.links) {
      const key = linkRefKey(state.ref)
      if (links.has(key)) continue
      const working = workingLinkFromState(state)
      if (state.effective || this.resolveLink(working, objects)) links.set(key, working)
    }
    this.dependencies.observeCoreBuffer?.("edits.incident-links", links.size)
  }

  private async loadState(
    storage: OntologyMaterializationStorage,
    session: MaterializationSession,
    request: import("../storage/ontology").MaterializationStateRequestChunk
  ): Promise<MaterializationStatePage> {
    const result: MutableStatePage = { objects: [], links: [], linkScopes: [], points: [] }
    for await (const page of storage.streamState({
      session,
      requests: oneStateRequest(request),
      pageRows: this.batching.statePageRows,
    })) {
      result.objects.push(...page.objects)
      result.links.push(...page.links)
      result.linkScopes.push(...page.linkScopes)
      result.points.push(...page.points)
    }
    return result
  }

  private async applyItems(
    storage: OntologyMaterializationStorage,
    session: MaterializationSession,
    items: Iterable<MaterializationPlanItem>,
    signal?: AbortSignal
  ): Promise<void> {
    for await (const chunk of planStream(items, this.batching)) {
      throwIfAborted(signal)
      await storage.applyChunk({ session, chunk })
    }
  }

  private async stageWorkBounded(
    storage: OntologyMaterializationStorage,
    session: MaterializationSession,
    records: readonly import("../storage/ontology").MaterializationWorkRecord[]
  ): Promise<void> {
    let chunk: import("../storage/ontology").MaterializationWorkRecord[] = []
    let bytes = 0
    const flush = async () => {
      if (chunk.length === 0) return
      await storage.stageWork({ session, records: chunk })
      chunk = []
      bytes = 0
    }
    for (const record of records) {
      const recordBytes = utf8JsonByteLength(record)
      if (
        chunk.length > 0 &&
        (chunk.length >= this.batching.planChunkRows ||
          bytes + recordBytes > this.batching.planChunkBytes)
      ) {
        await flush()
      }
      chunk.push(record)
      bytes += recordBytes
    }
    await flush()
  }

  private async drainStagedWork(
    storage: OntologyMaterializationStorage,
    session: MaterializationSession,
    signal?: AbortSignal
  ): Promise<void> {
    let phase: number | null = null
    let pending: MaterializationPlanItem[] = []
    const flush = async () => {
      if (pending.length === 0) return
      await this.applyItems(storage, session, pending, signal)
      pending = []
    }
    for await (const page of storage.streamWork({
      session,
      order: "apply",
      pageRows: this.batching.planChunkRows,
    })) {
      for (const record of page.records) {
        if (record.kind !== "plan") {
          throw new MaterializationValidationError("Provider returned non-plan apply work.")
        }
        if (phase !== null && record.applyPhase !== phase) await flush()
        phase = record.applyPhase
        pending.push(record.item)
        if (pending.length >= this.batching.planChunkRows) await flush()
      }
    }
    await flush()
  }

  private async validateStagedCardinality(
    storage: OntologyMaterializationStorage,
    session: MaterializationSession,
    signal?: AbortSignal
  ): Promise<void> {
    let currentScope: string | null = null
    let occupant: string | null = null
    for await (const page of storage.streamWork({
      session,
      order: "cardinality",
      pageRows: this.batching.statePageRows,
    })) {
      throwIfAborted(signal)
      for (const record of page.records) {
        if (record.kind !== "cardinality") {
          throw new MaterializationValidationError(
            "Provider returned non-cardinality cardinality work."
          )
        }
        if (record.scopeSortKey !== currentScope) {
          currentScope = record.scopeSortKey
          occupant = null
        }
        if (!record.occupied) continue
        if (occupant && occupant !== record.linkSortKey) {
          throw new MaterializationValidationError(
            `Link scope '${record.ref.source.objectTypeId}.${record.ref.linkId}' has cardinality one.`
          )
        }
        occupant = record.linkSortKey
      }
    }
  }

  private async drainStagedEvents(
    storage: OntologyMaterializationStorage,
    session: MaterializationSession,
    identity: FixedCommitIdentity,
    signal?: AbortSignal
  ): Promise<number> {
    let ordinal = 0
    for await (const page of storage.streamWork({
      session,
      order: "event",
      pageRows: this.batching.planChunkRows,
    })) {
      const items: MaterializationPlanItem[] = []
      for (const record of page.records) {
        if (record.kind !== "event") {
          throw new MaterializationValidationError("Provider returned non-event event work.")
        }
        const event = sequenceMaterializationEvent(
          this.projectId,
          identity.commitId,
          ordinal++,
          record.draft
        )
        items.push(outboxItem(event, identity.committedAt))
      }
      await this.applyItems(storage, session, items, signal)
    }
    return ordinal
  }

  private async replay<
    TResult extends EditCommitResult | ProjectionCommitResult | TelemetryCommitResult,
  >(identity: FixedCommitIdentity, storage = this.storage): Promise<TResult | null> {
    const existing = await storage.ontology.commits.getByIdempotencyKey({
      projectId: this.projectId,
      idempotencyKey: identity.idempotencyKey,
    })
    if (!existing) return null
    if (existing.requestHash !== identity.requestHash)
      throw new MaterializationConflictError(
        "idempotency",
        `Idempotency key '${identity.idempotencyKey}' was reused with different intent.`
      )
    return { ...structuredClone(existing.result), created: false } as TResult
  }

  private async withSerializationRetry<T>(run: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await run()
      } catch (error) {
        if (!isStorageSerializationFailure(error) || attempt >= this.maxSerializationRetries)
          throw error
        this.dependencies.onSerializationRetry?.(attempt + 1, error)
      }
    }
  }

  private async attachRunReplay(
    kind: "action" | "projection",
    runId: string,
    commitId: string
  ): Promise<void> {
    await this.storage.transaction(
      (tx) => attachRunReplay(tx, this.projectId, kind, runId, commitId),
      { isolation: "serializable" }
    )
  }
}

export function createOntologyMaterializer(input: {
  readonly projectId: string
  readonly ontology: OntologyRegistry
  readonly projections: ProjectionRegistry
  readonly storage: MaterializerStorage
  readonly dependencies?: OntologyMaterializerDependencies
}): OntologyMaterializer {
  return new OntologyMaterializer(
    input.projectId,
    input.ontology,
    input.projections,
    input.storage,
    input.dependencies
  )
}

type ObjectOperation = Extract<OntologyEditOperation, { readonly kind: `object.${string}` }>
type LinkOperation = Extract<OntologyEditOperation, { readonly kind: `link.${string}` }>
interface WorkingObject {
  ref: OntologyObjectRef
  source: MaterializationObjectState["source"]
  originalOverride: StoredObjectOverride | null
  override: ObjectOverride | null
  before: MaterializationObjectState["effective"]
  latestTelemetry: StoredTelemetryPoint[]
}
interface WorkingLink {
  ref: OntologyLinkRef
  source: MaterializationLinkState["source"]
  originalOverride: StoredLinkOverride | null
  override: LinkOverride | null
  before: MaterializationLinkState["effective"]
}
interface MutableStatePage {
  objects: MaterializationObjectState[]
  links: MaterializationLinkState[]
  linkScopes: import("../storage/ontology").MaterializationLinkScopeState[]
  points: StoredTelemetryPoint[]
}

function requireOntologyStorage(storage: Storage): MaterializerStorage {
  if (!storage.ontology)
    throw new MaterializationValidationError("Storage does not provide ontology capabilities.")
  return storage as MaterializerStorage
}

function mergeWorkingState(
  objects: Map<string, WorkingObject>,
  links: Map<string, WorkingLink>,
  scopes: Map<string, import("../storage/ontology").MaterializationLinkScopeState>,
  state: MaterializationStatePage
): void {
  for (const object of state.objects)
    if (!objects.has(objectRefKey(object.ref)))
      objects.set(objectRefKey(object.ref), workingObjectFromState(object))
  for (const link of state.links)
    if (!links.has(linkRefKey(link.ref)))
      links.set(linkRefKey(link.ref), workingLinkFromState(link))
  for (const scope of state.linkScopes)
    if (!scopes.has(scopeKey(scope.source, scope.linkId)))
      scopes.set(scopeKey(scope.source, scope.linkId), scope)
}

function workingObjectFromState(object: MaterializationObjectState): WorkingObject {
  return {
    ref: object.ref,
    source: object.source,
    originalOverride: object.override,
    override: object.override?.value ?? null,
    before: object.effective,
    latestTelemetry: [...object.latestTelemetry],
  }
}

function workingLinkFromState(link: MaterializationLinkState): WorkingLink {
  return {
    ref: link.ref,
    source: link.source,
    originalOverride: link.override,
    override: link.override?.value ?? null,
    before: link.effective,
  }
}

function distinctCardinalityOneScopes(
  ontology: OntologyRegistry,
  links: readonly MaterializationLinkState[],
  existing: Map<string, import("../storage/ontology").MaterializationLinkScopeState>
): { readonly source: OntologyObjectRef; readonly linkId: string }[] {
  const scopes = new Map<string, { readonly source: OntologyObjectRef; readonly linkId: string }>()
  for (const state of links) {
    const definition = ontology
      .resolveObjectType(state.ref.source.objectTypeId)
      .links.find((candidate) => candidate.id === state.ref.linkId)
    const key = scopeKey(state.ref.source, state.ref.linkId)
    if (definition?.cardinality === "one" && !existing.has(key)) {
      scopes.set(key, { source: state.ref.source, linkId: state.ref.linkId })
    }
  }
  return [...scopes.values()]
}

function provisionalObjectSnapshot(
  working: WorkingObject,
  resolved: NonNullable<ReturnType<typeof resolveEffectiveObject>>,
  identity: FixedCommitIdentity
) {
  return {
    ...resolved,
    version: working.before?.version ?? 1,
    createdAt: working.before?.createdAt ?? identity.committedAt,
    updatedAt: identity.committedAt,
    lastCommitId: identity.commitId,
  }
}

function resultingObjectSnapshot(
  working: WorkingObject,
  resolved: NonNullable<ReturnType<typeof resolveEffectiveObject>>,
  identity: FixedCommitIdentity
) {
  if (
    working.before &&
    stableJsonStringify(working.before.properties) === stableJsonStringify(resolved.properties)
  )
    return working.before
  if (!working.before) return provisionalObjectSnapshot(working, resolved, identity)
  return {
    ...resolved,
    version: working.before.version + 1,
    createdAt: working.before.createdAt,
    updatedAt: identity.committedAt,
    lastCommitId: identity.commitId,
  }
}
function provisionalLinkSnapshot(
  working: WorkingLink,
  resolved: NonNullable<ReturnType<typeof resolveEffectiveLink>>,
  identity: FixedCommitIdentity
) {
  return {
    ...resolved,
    createdAt: working.before?.createdAt ?? identity.committedAt,
    updatedAt: identity.committedAt,
    lastCommitId: identity.commitId,
  }
}

function appendObjectOverridePlan(
  items: MaterializationPlanWorkItem[],
  working: WorkingObject,
  identity: FixedCommitIdentity
): void {
  if (
    stableJsonStringify(working.originalOverride?.value ?? null) ===
    stableJsonStringify(working.override)
  )
    return
  if (working.override)
    items.push({
      kind: "object-override-upsert",
      value: {
        ref: working.ref,
        value: working.override,
        expectedLastCommitId: working.originalOverride?.lastCommitId ?? null,
        lastCommitId: identity.commitId,
        updatedAt: identity.committedAt,
      },
    })
  else if (working.originalOverride)
    items.push({
      kind: "object-override-delete",
      value: { ref: working.ref, expectedLastCommitId: working.originalOverride.lastCommitId },
    })
}
function appendLinkOverridePlan(
  items: MaterializationPlanWorkItem[],
  working: WorkingLink,
  identity: FixedCommitIdentity
): void {
  if (
    stableJsonStringify(working.originalOverride?.value ?? null) ===
    stableJsonStringify(working.override)
  )
    return
  if (working.override)
    items.push({
      kind: "link-override-upsert",
      value: {
        ref: working.ref,
        value: working.override,
        expectedLastCommitId: working.originalOverride?.lastCommitId ?? null,
        lastCommitId: identity.commitId,
        updatedAt: identity.committedAt,
      },
    })
  else if (working.originalOverride)
    items.push({
      kind: "link-override-delete",
      value: { ref: working.ref, expectedLastCommitId: working.originalOverride.lastCommitId },
    })
}
function appendObjectEffectivePlan(
  items: MaterializationPlanWorkItem[],
  change: EffectiveObjectChange
): void {
  if (change.kind === "deleted")
    items.push({
      kind: "object-delete",
      value: {
        ref: change.ref,
        expected: expectedObject(change.before) as Extract<
          ReturnType<typeof expectedObject>,
          { exists: true }
        >,
      },
    })
  else
    items.push({
      kind: "object-upsert",
      value: {
        row: change.after,
        expected: change.before
          ? expectedObject(change.before)
          : { ref: change.ref, exists: false },
      },
    })
}
function appendLinkEffectivePlan(
  items: MaterializationPlanWorkItem[],
  change: EffectiveLinkChange
): void {
  if (change.kind === "deleted")
    items.push({
      kind: "link-delete",
      value: {
        ref: change.ref,
        expected: expectedLink(change.before) as Extract<
          ReturnType<typeof expectedLink>,
          { exists: true }
        >,
      },
    })
  else
    items.push({
      kind: "link-upsert",
      value: {
        row: change.after,
        expected: change.before ? expectedLink(change.before) : { ref: change.ref, exists: false },
      },
    })
}
function expectedObject(snapshot: NonNullable<EffectiveObjectChange["before"]>) {
  return {
    ref: snapshot.ref,
    exists: true as const,
    version: snapshot.version,
    lastCommitId: snapshot.lastCommitId,
  }
}
function expectedLink(snapshot: NonNullable<EffectiveLinkChange["before"]>) {
  return { ref: snapshot.ref, exists: true as const, lastCommitId: snapshot.lastCommitId }
}
function outboxItem(
  event: import("../storage/ontology").OntologyMaterializationEvent,
  committedAt: string
): MaterializationPlanItem {
  const value: OntologyOutboxWrite = {
    envelope: event,
    availableAt: committedAt,
    createdAt: committedAt,
  }
  return { kind: "outbox", value }
}

function classificationWork(
  entityKind: import("../storage/ontology").MaterializationWorkEntityKind,
  identityKey: string,
  sortKey: string
): import("../storage/ontology").MaterializationClassificationWorkRecord {
  return {
    kind: "classification",
    recordKey: `classification:${entityKind}:${sortKey}`,
    entityKind,
    identityKey,
  }
}

function planWork(
  item: MaterializationPlanWorkItem,
  sortKey: string
): MaterializationPlanWorkRecord {
  const applyPhase = planApplyPhase(item)
  return {
    kind: "plan",
    recordKey: `plan:${item.kind}:${sortKey}`,
    applyPhase,
    sortKey,
    item,
  }
}

function planApplyPhase(
  item: MaterializationPlanWorkItem
): import("../storage/ontology").MaterializationApplyPhase {
  switch (item.kind) {
    case "object-override-upsert":
    case "object-override-delete":
    case "link-override-upsert":
    case "link-override-delete":
      return 0
    case "point-upsert":
      return 1
    case "link-delete":
      return 2
    case "object-delete":
      return 3
    case "object-upsert":
      return 4
    case "link-upsert":
      return 5
  }
}

function eventWork(
  value: import("./build-events").OrderedMaterializationEventDraft
): readonly MaterializationEventWorkRecord[] {
  return [
    {
      kind: "event",
      recordKey: `event:${value.kindRank}:${value.sortKey}`,
      eventKindRank: value.kindRank,
      sortKey: value.sortKey,
      draft: value.draft,
    },
  ]
}
function scopeKey(source: OntologyObjectRef, linkId: string): string {
  return JSON.stringify([source.objectTypeId, source.primaryId, linkId])
}
function emptyCounts(): MutableCounts {
  return {
    objectsCreated: 0,
    objectsUpdated: 0,
    objectsDeleted: 0,
    objectsUnchanged: 0,
    linksCreated: 0,
    linksUpdated: 0,
    linksDeleted: 0,
    linksUnchanged: 0,
  }
}
type MutableCounts = { -readonly [K in keyof EffectiveChangeCounts]: EffectiveChangeCounts[K] }
function incrementObjectCount(counts: MutableCounts, kind: EffectiveObjectChange["kind"]): void {
  if (kind === "created") counts.objectsCreated += 1
  else if (kind === "updated") counts.objectsUpdated += 1
  else counts.objectsDeleted += 1
}
function incrementLinkCount(counts: MutableCounts, kind: EffectiveLinkChange["kind"]): void {
  if (kind === "created") counts.linksCreated += 1
  else if (kind === "updated") counts.linksUpdated += 1
  else counts.linksDeleted += 1
}
function validateProjectionWatermark(
  active: Awaited<ReturnType<OntologyStorage["sources"]["getActive"]>>,
  next: import("./types").PinnedDatasetVersion
): void {
  if (!active) return
  const currentAt = Date.parse(active.datasetVersion.createdAt)
  const nextAt = Date.parse(next.createdAt)
  if (nextAt < currentAt)
    throw new MaterializationConflictError(
      "projection-fence",
      "Projection replacement dataset version is older than the active watermark."
    )
  if (nextAt === currentAt && active.datasetVersion.versionId !== next.versionId)
    throw new MaterializationConflictError(
      "projection-fence",
      "Projection replacement dataset watermark is ambiguous."
    )
}
function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted)
    throw signal.reason instanceof Error
      ? signal.reason
      : new DOMException("Projection replacement aborted", "AbortError")
}
const INACTIVE_GENERATION_RETENTION_MS = 24 * 60 * 60 * 1_000
function inactiveGenerationCleanupCutoff(now: string): string {
  return new Date(Date.parse(now) - INACTIVE_GENERATION_RETENTION_MS).toISOString()
}
async function bestEffort(run: () => Promise<unknown>): Promise<void> {
  try {
    await run()
  } catch {}
}

async function attachRunReplay(
  storage: Storage,
  projectId: string,
  kind: "action" | "projection",
  runId: string,
  commitId: string
): Promise<void> {
  const runStorage = kind === "action" ? storage.actionRuns : storage.projectionRuns
  await runStorage?.recordMaterializationReplay?.(projectId, runId, commitId)
}
