import { assertNever } from "../assert-never"
import { assertAuthorized, isAllowed } from "../authorization"
import { AuthorizationError } from "../authorization/errors"
import type { AuthorizationContext } from "../authorization/types"
import type { EmbeddingModelCatalog, RerankingModelCatalog } from "../models/catalog"
import {
  type AuthorizedOntologySelection,
  type AuthorizedOntologyView,
  createAuthorizedOntologyView,
} from "../objects/authorized-ontology-view"
import {
  createClearanceQueryAdmission,
  type PropertyClearance,
  redactObjectRow,
  resolvePropertyClearance,
} from "../objects/property-clearance"
import {
  countObjects,
  type ExecuteObjectCountInput,
  type ExecuteObjectCountResult,
  type ExecuteObjectExistsInput,
  type ExecuteObjectExistsResult,
  type ExecuteObjectFacetsInput,
  type ExecuteObjectFacetsResult,
  type ExecuteObjectQueryInput,
  type ExecuteObjectQueryLinksInput,
  type ExecuteObjectQueryLinksResult,
  type ExecuteObjectQueryResult,
  executeObjectQuery,
  executeObjectQueryLinks,
  existsObjects,
  facetObjects,
} from "../objects/query"
import { ObjectQueryValidationError } from "../objects/query/errors"
import { validateObjectFacetRequests } from "../objects/query/executor"
import type { ObjectQuery } from "../objects/query/ir"
import { preflightObjectQueryLinks } from "../objects/query/links"
import {
  createSelectedObjectQueryAdmission,
  type SelectedObjectQueryAdmission,
} from "../objects/query/selected-read-admission"
import {
  type AdmittedObjectQuery,
  composeObjectQueryAdmissions,
  type ObjectQuerySemanticAdmission,
  validateObjectQuery,
  validateObjectQueryWithAdmission,
} from "../objects/query/validate"
import {
  admitTelemetryHistoryReadWorkload,
  type TelemetryHistoryReadAdmission,
  type TelemetryHistoryReadWorkloadInput,
} from "../objects/telemetry/workload"
import type { OntologyRegistry } from "../ontology"
import type {
  CompiledObjectReadStep,
  LinkBatchKey,
  ObjectFacetRequest,
  ObjectLinkRow,
  ObjectReadStorage,
  ObjectRow,
  ObjectStorage,
} from "../storage"
import { assertObjectReadOutputWithinLimit, MAX_OBJECT_READ_FACETS } from "../storage"
import { captureExecutionScope, resolveExecutionScopeAuthorization } from "./authorization"
import type { ExecutionScope, RuntimeAuthorization } from "./types"

type RuntimeReadAuthorization = {
  readonly projectId: string
  readonly runtimeAuthorization: RuntimeAuthorization
  readonly authorization?: AuthorizationContext
}

type ResolvedExecutionAuthority = ReturnType<typeof resolveExecutionScopeAuthorization>
type GetObjectInput = Omit<Parameters<ObjectReadStorage["getByPrimaryId"]>[0], "projectId">
type GetObjectsInput = Omit<Parameters<ObjectReadStorage["getByPrimaryIdBatch"]>[0], "projectId">
type SelectObjectPropertiesInput = Parameters<ObjectReadStorage["selectsObjectProperties"]>[0]
type CanReadObjectPropertyInput = SelectObjectPropertiesInput["items"][number]
type CanReadObjectPropertiesBatchInput = Omit<SelectObjectPropertiesInput, "projectId">
type ListObjectsInput = Omit<Parameters<ObjectReadStorage["list"]>[0], "projectId">
type ListLinksInput = Omit<Parameters<ObjectReadStorage["listLinks"]>[0], "projectId">
type ListLinksBatchInput = Omit<Parameters<ObjectReadStorage["listLinksBatch"]>[0], "projectId">

const readerConstructionKey = Object.freeze({})

/**
 * Core-owned object read boundary for one exact execution authority.
 *
 * The implementation class is intentionally private to this module. Its private fields make the
 * exported instance type nominal, while the construction key prevents code that discovers the
 * JavaScript constructor through an instance from manufacturing another reader.
 */
class AuthorizedObjectReaderImpl {
  readonly #authorization: RuntimeAuthorization
  readonly #authority: ResolvedExecutionAuthority
  readonly #runtime: RuntimeReadAuthorization
  readonly #ontology: OntologyRegistry
  readonly #embeddingModels?: EmbeddingModelCatalog
  readonly #rerankingModels?: RerankingModelCatalog
  #ontologyView?: AuthorizedOntologyView
  readonly #storage: ObjectReadStorage
  readonly #delegatedObjectTypeIds?: ReadonlySet<string>
  readonly #delegatedLinkDefinitions?: ReadonlySet<string>
  readonly #delegatedQueryAdmission?: SelectedObjectQueryAdmission
  /** Marked properties this authority cannot read; absent when it reads every property. */
  readonly #clearance?: PropertyClearance

  constructor(
    key: typeof readerConstructionKey,
    input: {
      readonly scope: ExecutionScope
      readonly ontology: OntologyRegistry
      readonly embeddingModels?: EmbeddingModelCatalog
      readonly rerankingModels?: RerankingModelCatalog
      readonly storage: ObjectReadStorage
      readonly authority: ResolvedExecutionAuthority
    }
  ) {
    if (key !== readerConstructionKey) {
      throw new Error("[Sixb] AuthorizedObjectReader can only be created by Core.")
    }

    this.#authorization = input.scope.authorization
    this.#authority = input.authority
    this.#ontology = input.ontology
    this.#embeddingModels = input.embeddingModels
    this.#rerankingModels = input.rerankingModels
    this.#storage = input.storage
    this.#delegatedObjectTypeIds =
      input.authority.type === "delegated"
        ? new Set(input.authority.objectRead.scope.objects.map((object) => object.objectTypeId))
        : undefined
    this.#delegatedLinkDefinitions =
      input.authority.type === "delegated"
        ? new Set(input.authority.objectRead.scope.steps.map(delegatedLinkDefinitionKey))
        : undefined
    this.#delegatedQueryAdmission =
      input.authority.type === "delegated"
        ? createSelectedObjectQueryAdmission(input.authority.objectRead.scope)
        : undefined
    this.#clearance = clearanceForAuthority(input.authority, input.ontology)
    this.#runtime = Object.freeze({
      projectId: input.scope.execution.projectId,
      runtimeAuthorization: input.scope.authorization,
      ...(input.authority.type === "principal" ? { authorization: input.authority.context } : {}),
    })
  }

  static assertBound(reader: AuthorizedObjectReaderImpl, scope: ExecutionScope): void {
    const capturedScope = captureExecutionScope(scope)
    resolveExecutionScopeAuthorization(reader.#runtime.projectId, capturedScope)
    if (capturedScope.authorization !== reader.#authorization) {
      throw new Error(
        "[Sixb] AuthorizedObjectReader is not bound to this exact execution authority."
      )
    }
  }

  static ontologyView(reader: AuthorizedObjectReaderImpl): AuthorizedOntologyView {
    const authority = reader.#authority
    reader.#ontologyView ??= createAuthorizedOntologyView({
      ontology: reader.#ontology,
      selection: ontologySelectionForAuthority(authority, reader.#ontology),
      ...(authority.type === "delegated"
        ? {
            assertOutputWithinLimit: (value: unknown) =>
              assertObjectReadOutputWithinLimit(value, authority.objectRead.limits),
          }
        : {}),
    })
    return reader.#ontologyView
  }

  /** Project identity carried by this nominal reader capability. */
  get projectId(): string {
    return this.#runtime.projectId
  }

  async getByPrimaryId(input: GetObjectInput): ReturnType<ObjectReadStorage["getByPrimaryId"]> {
    const request = snapshotReadValue({
      objectTypeId: input.objectTypeId,
      primaryId: input.primaryId,
    })
    this.#assertObjectTypesViewable([request.objectTypeId])
    const row = await this.#storage.getByPrimaryId({
      ...request,
      projectId: this.#runtime.projectId,
    })
    return detachReadResult(row && this.#redact(row))
  }

  async getByPrimaryIdBatch(
    input: GetObjectsInput
  ): ReturnType<ObjectReadStorage["getByPrimaryIdBatch"]> {
    const request = snapshotReadValue({
      items: input.items.map((item) => ({
        objectTypeId: item.objectTypeId,
        primaryId: item.primaryId,
      })),
    })
    this.#assertObjectTypesViewable(request.items.map((item) => item.objectTypeId))
    const rows = await this.#storage.getByPrimaryIdBatch({
      ...request,
      projectId: this.#runtime.projectId,
    })
    return detachReadResult(
      new Map([...rows].map(([key, row]) => [key, this.#redact(row)] as const))
    )
  }

  async canReadObjectProperty(input: CanReadObjectPropertyInput): Promise<boolean> {
    const request = snapshotReadValue({
      objectTypeId: input.objectTypeId,
      primaryId: input.primaryId,
      propertyId: input.propertyId,
    })
    this.#assertObjectTypesViewable([request.objectTypeId])
    if (this.#hidesProperty(request)) return false
    if (this.#authority.type !== "delegated") return true
    const [readable] = await this.#storage.selectsObjectProperties({
      projectId: this.#runtime.projectId,
      items: [request],
    })
    return readable ?? false
  }

  async canReadObjectPropertiesBatch(
    input: CanReadObjectPropertiesBatchInput
  ): Promise<readonly boolean[]> {
    const request = snapshotReadValue({
      items: input.items.map((item) => ({
        objectTypeId: item.objectTypeId,
        primaryId: item.primaryId,
        propertyId: item.propertyId,
      })),
    })
    this.#assertObjectTypesViewable(request.items.map((item) => item.objectTypeId))
    const selected =
      this.#authority.type === "delegated"
        ? await this.#storage.selectsObjectProperties({
            ...request,
            projectId: this.#runtime.projectId,
          })
        : request.items.map(() => true)
    return request.items.map(
      (item, index) => !this.#hidesProperty(item) && selected[index] === true
    )
  }

  async list(input: ListObjectsInput): ReturnType<ObjectReadStorage["list"]> {
    const request = snapshotReadValue({
      objectTypeId:
        typeof input.objectTypeId === "string"
          ? input.objectTypeId
          : input.objectTypeId === undefined
            ? undefined
            : [...input.objectTypeId],
      primaryIdPrefix: input.primaryIdPrefix,
      primaryIdSuffix: input.primaryIdSuffix,
      updatedAfter: input.updatedAfter,
      updatedBefore: input.updatedBefore,
      createdAfter: input.createdAfter,
      createdBefore: input.createdBefore,
      limit: input.limit,
      offset: input.offset,
      orderBy: input.orderBy,
      order: input.order,
    })
    const objectTypeId = this.#resolveListObjectTypes(request.objectTypeId)

    // An empty type selection means "none", never "all". Short-circuiting here prevents a
    // provider with different empty-array semantics from turning a principal read into a broad one.
    if (Array.isArray(objectTypeId) && objectTypeId.length === 0) {
      return { objects: [], hasMore: false, total: 0 }
    }

    const page = await this.#storage.list({
      ...request,
      ...(objectTypeId === undefined ? {} : { objectTypeId }),
      projectId: this.#runtime.projectId,
    })
    return detachReadResult({ ...page, objects: page.objects.map((row) => this.#redact(row)) })
  }

  async listLinks(input: ListLinksInput): ReturnType<ObjectReadStorage["listLinks"]> {
    const request = snapshotReadValue({
      objectTypeId: input.objectTypeId,
      objectId: input.objectId,
      linkId: input.linkId,
      direction: input.direction,
    })
    this.#assertObjectTypesViewable([request.objectTypeId])
    const links = detachReadResult(
      await this.#storage.listLinks({
        ...request,
        projectId: this.#runtime.projectId,
      })
    )
    return links.filter((link) => this.#isLinkViewable(link))
  }

  async listLinksBatch(
    input: ListLinksBatchInput
  ): ReturnType<ObjectReadStorage["listLinksBatch"]> {
    const request = snapshotReadValue({
      direction: input.direction,
      items: input.items.map((item) => ({
        objectTypeId: item.objectTypeId,
        objectId: item.objectId,
        linkId: item.linkId,
      })),
    })
    this.#assertObjectTypesViewable(request.items.map((item) => item.objectTypeId))
    const pages = detachReadResult(
      await this.#storage.listLinksBatch({
        ...request,
        projectId: this.#runtime.projectId,
      })
    )
    const filtered = new Map<LinkBatchKey, ObjectLinkRow[]>()
    for (const [key, links] of pages) {
      filtered.set(
        key,
        links.filter((link) => this.#isLinkViewable(link))
      )
    }
    return filtered
  }

  async executeQuery(
    input: Omit<ExecuteObjectQueryInput, "projectId">
  ): Promise<ExecuteObjectQueryResult> {
    const query = snapshotAuthoredQuery(input.query)
    const includeTotal = snapshotReadValue(input.includeTotal)
    const executionQuery = this.#admitDelegatedQuery(query)?.query ?? query
    const result = await executeObjectQuery(
      {
        query: executionQuery,
        ...(includeTotal === undefined ? {} : { includeTotal }),
        projectId: this.#runtime.projectId,
        signal: input.signal,
      },
      this.#queryExecutorOptions()
    )
    return detachReadResult({ ...result, objects: result.objects.map((row) => this.#redact(row)) })
  }

  async queryLinks(
    input: Omit<ExecuteObjectQueryLinksInput, "projectId">
  ): Promise<ExecuteObjectQueryLinksResult> {
    const query = snapshotAuthoredQuery(input.query)
    const request = snapshotReadValue({
      direction: input.direction,
      linkId: input.linkId,
      includeObjects: input.includeObjects,
      pageSize: input.pageSize,
      pageToken: input.pageToken,
    })
    let executionQuery = query
    const admission = this.#delegatedQueryAdmission
    if (admission) {
      const preflight = preflightObjectQueryLinks(
        { query, ...request, projectId: this.#runtime.projectId },
        { ontology: this.#ontology }
      )
      const admitted = validateObjectQueryWithAdmission(
        preflight.validated.query,
        { ontology: this.#ontology, normalize: false },
        admission
      )
      admission.assertIncidentEdgeSelected({
        state: admitted.admissionState,
        ...(preflight.linkId === undefined ? {} : { linkId: preflight.linkId }),
        direction: preflight.direction,
        path: "$.linkId",
      })
      executionQuery = admitted.query
    }
    const result = detachReadResult(
      await executeObjectQueryLinks(
        { query: executionQuery, ...request, projectId: this.#runtime.projectId },
        this.#queryExecutorOptions()
      )
    )

    // Link pagination is computed by the provider-facing executor. Filtering afterward would make
    // its cursor and hasMore metadata describe hidden rows, so a provider contract violation must
    // fail closed instead of returning a partially filtered page.
    if (
      result.objects.some((row) => !this.#isObjectTypeViewable(row.objectTypeId)) ||
      result.links.some((link) => !this.#isLinkViewable(link))
    ) {
      throw new Error("[Sixb] Object storage returned a link page outside its authorized scope.")
    }
    return { ...result, objects: result.objects.map((row) => this.#redact(row)) }
  }

  async count(
    input: Omit<ExecuteObjectCountInput, "projectId">
  ): Promise<ExecuteObjectCountResult> {
    const query = snapshotAuthoredQuery(input.query)
    const executionQuery = this.#admitDelegatedQuery(query)?.query ?? query
    return detachReadResult(
      await countObjects(
        { query: executionQuery, projectId: this.#runtime.projectId },
        this.#queryExecutorOptions()
      )
    )
  }

  async exists(
    input: Omit<ExecuteObjectExistsInput, "projectId">
  ): Promise<ExecuteObjectExistsResult> {
    const query = snapshotAuthoredQuery(input.query)
    const executionQuery = this.#admitDelegatedQuery(query)?.query ?? query
    return detachReadResult(
      await existsObjects(
        { query: executionQuery, projectId: this.#runtime.projectId },
        this.#queryExecutorOptions()
      )
    )
  }

  async facet(
    input: Omit<ExecuteObjectFacetsInput, "projectId">
  ): Promise<ExecuteObjectFacetsResult> {
    const query = snapshotAuthoredQuery(input.query)
    const facets = snapshotFacetRequests(input.facets)
    let executionQuery = query
    let executionFacets = facets
    const admission = this.#delegatedQueryAdmission
    if (admission) {
      // Terminal arguments are ordinary validation errors, not an authorization oracle. Validate
      // them against the canonical result shape before raising any delegated-scope denial.
      const validated = validateObjectQuery(query, { ontology: this.#ontology })
      const normalizedFacets = validateObjectFacetRequests(facets, validated.result.objectTypeIds, {
        ontology: this.#ontology,
      })
      const admitted = validateObjectQueryWithAdmission(
        validated.query,
        { ontology: this.#ontology, normalize: false },
        admission
      )
      normalizedFacets.forEach((facet, index) => {
        admission.assertPropertySelected({
          state: admitted.admissionState,
          propertyId: facet.propertyId,
          use: "facet",
          path: `$.facets[${index}].propertyId`,
        })
      })
      executionQuery = admitted.query
      executionFacets = normalizedFacets
    }
    return detachReadResult(
      await facetObjects(
        {
          query: executionQuery,
          facets: executionFacets,
          projectId: this.#runtime.projectId,
        },
        this.#queryExecutorOptions()
      )
    )
  }

  /**
   * Redact a row returned by a write. An upsert returns the merged effective row, which may hold
   * marked values the writer never sent and cannot read.
   */
  redactWrittenRow<TRow extends ObjectRow>(row: TRow): TRow {
    return this.#redact(row)
  }

  /** Enforce the delegated response budget without exposing or recombining its limits. */
  assertVisibleOutputWithinLimit(value: unknown): void {
    if (this.#authority.type !== "delegated") return
    assertObjectReadOutputWithinLimit(value, this.#authority.objectRead.limits)
  }

  /** Admit adjacent telemetry work without exposing which authority policy was selected. */
  admitTelemetryHistoryRead(
    input: TelemetryHistoryReadWorkloadInput
  ): TelemetryHistoryReadAdmission {
    return admitTelemetryHistoryReadWorkload(input, this.#authority.type === "delegated")
  }

  #queryExecutorOptions() {
    const admission = this.#executorAdmission()
    if (this.#authority.type === "delegated") {
      // The selected storage instance is the private execution capability. Passing the delegated
      // runtime token into the generic executor would either reject this admitted query or tempt a
      // forgeable bypass flag; neither is needed at this nominal boundary.
      return {
        ontology: this.#ontology,
        storage: this.#storage,
        embeddingModels: this.#embeddingModels,
        rerankingModels: this.#rerankingModels,
        ...(admission === undefined ? {} : { admission }),
      }
    }
    return {
      ontology: this.#ontology,
      embeddingModels: this.#embeddingModels,
      rerankingModels: this.#rerankingModels,
      storage: this.#storage,
      runtimeAuthorization: this.#runtime.runtimeAuthorization,
      ...(this.#runtime.authorization === undefined
        ? {}
        : { authorization: this.#runtime.authorization }),
      ...(admission === undefined ? {} : { admission }),
    }
  }

  /**
   * The executor validates the query it runs, and that validation resolves default text fields.
   * Every admission that narrows those fields must therefore apply there, not only beforehand.
   */
  #executorAdmission(): ObjectQuerySemanticAdmission | undefined {
    const clearance = this.#clearance && createClearanceQueryAdmission(this.#clearance)
    const selected = this.#delegatedQueryAdmission
    if (selected && clearance) return composeObjectQueryAdmissions(selected, clearance)
    return selected ?? clearance
  }

  #redact<TRow extends ObjectRow>(row: TRow): TRow {
    return this.#clearance ? redactObjectRow(row, this.#clearance) : row
  }

  #hidesProperty(item: { readonly objectTypeId: string; readonly propertyId: string }): boolean {
    return this.#clearance?.hiddenPropertyIds(item.objectTypeId).has(item.propertyId) ?? false
  }

  #admitDelegatedQuery(query: ObjectQuery): AdmittedObjectQuery | undefined {
    if (!this.#delegatedQueryAdmission) return undefined
    return validateObjectQueryWithAdmission(
      query,
      { ontology: this.#ontology },
      this.#delegatedQueryAdmission
    )
  }

  #assertObjectTypesViewable(objectTypeIds: readonly string[]): void {
    if (this.#authority.type === "delegated") {
      for (const objectTypeId of new Set(objectTypeIds)) {
        if (this.#delegatedObjectTypeIds?.has(objectTypeId)) continue
        throw new AuthorizationError(
          `delegated:object.view:${objectTypeId}`,
          `[Sixb] Delegated authorization does not select object type '${objectTypeId}'.`
        )
      }
      return
    }

    for (const objectTypeId of new Set(objectTypeIds)) {
      assertAuthorized(this.#runtime, { kind: "object.view", objectTypeId })
    }
  }

  #resolveListObjectTypes(
    requested: ListObjectsInput["objectTypeId"]
  ): ListObjectsInput["objectTypeId"] {
    if (requested !== undefined) {
      const objectTypeIds = typeof requested === "string" ? [requested] : [...new Set(requested)]
      for (const objectTypeId of objectTypeIds) {
        this.#ontology.resolveObjectType(objectTypeId)
      }
      this.#assertObjectTypesViewable(objectTypeIds)
      return typeof requested === "string" ? requested : objectTypeIds
    }

    if (this.#authority.type === "unrestricted") return undefined
    return this.#ontology
      .listObjectTypes()
      .map((objectType) => objectType.id)
      .filter((objectTypeId) => this.#isObjectTypeViewable(objectTypeId))
  }

  #isObjectTypeViewable(objectTypeId: string): boolean {
    if (this.#authority.type === "delegated") {
      return this.#delegatedObjectTypeIds?.has(objectTypeId) ?? false
    }
    return isAllowed(this.#runtime.authorization, { kind: "object.view", objectTypeId })
  }

  #isLinkViewable(link: ObjectLinkRow): boolean {
    if (
      !this.#isObjectTypeViewable(link.sourceTypeId) ||
      !this.#isObjectTypeViewable(link.targetTypeId)
    ) {
      return false
    }
    return (
      this.#delegatedLinkDefinitions?.has(delegatedLinkDefinitionKey(link)) ??
      this.#authority.type !== "delegated"
    )
  }
}

Object.freeze(AuthorizedObjectReaderImpl.prototype)
Object.freeze(AuthorizedObjectReaderImpl)

export type AuthorizedObjectReader = AuthorizedObjectReaderImpl

/** Build the sole application-facing object reader for one registered execution scope. */
export function createAuthorizedObjectReader(input: {
  readonly scope: ExecutionScope
  readonly ontology: OntologyRegistry
  readonly embeddingModels?: EmbeddingModelCatalog
  readonly rerankingModels?: RerankingModelCatalog
  readonly objectStorage: ObjectStorage
}): AuthorizedObjectReader {
  const scope = captureExecutionScope(input.scope)
  const projectId = scope.execution.projectId
  const authority = resolveExecutionScopeAuthorization(projectId, scope)
  const storage = objectStorageForAuthority(authority, input.objectStorage)
  const reader = new AuthorizedObjectReaderImpl(readerConstructionKey, {
    scope,
    ontology: input.ontology,
    embeddingModels: input.embeddingModels,
    rerankingModels: input.rerankingModels,
    storage,
    authority,
  })
  Object.freeze(reader)
  return reader
}

/** Reject recombining an authorized reader with any other execution authority. */
export function assertAuthorizedObjectReaderBinding(input: {
  readonly reader: AuthorizedObjectReader
  readonly scope: ExecutionScope
}): void {
  AuthorizedObjectReaderImpl.assertBound(input.reader, input.scope)
}

/** Return inert metadata projected from the exact authority already owned by the reader. */
export function getAuthorizedOntologyView(reader: AuthorizedObjectReader): AuthorizedOntologyView {
  return AuthorizedObjectReaderImpl.ontologyView(reader)
}

/**
 * Unrestricted authority reads every property. A principal reads what its roles clear; delegated
 * shared access carries no clearance, so no share can expose a marked property.
 */
function clearanceForAuthority(
  authority: ResolvedExecutionAuthority,
  ontology: OntologyRegistry
): PropertyClearance | undefined {
  switch (authority.type) {
    case "unrestricted":
      return undefined
    case "principal":
      return resolvePropertyClearance(ontology, authority.context.clearances ?? new Set())
    case "delegated":
      return resolvePropertyClearance(ontology, new Set())
  }
}

function objectStorageForAuthority(
  authority: ResolvedExecutionAuthority,
  objectStorage: ObjectStorage
): ObjectReadStorage {
  switch (authority.type) {
    case "principal":
    case "unrestricted":
      return objectStorage
    case "delegated":
      return objectStorage.createSelectedReadScope({
        projectId: authority.projectId,
        scope: authority.objectRead.scope,
        limits: authority.objectRead.limits,
      })
    default:
      return assertNever(
        authority,
        `[Sixb] Unsupported object reader authority '${String((authority as { type?: unknown }).type)}'.`
      )
  }
}

function ontologySelectionForAuthority(
  authority: ResolvedExecutionAuthority,
  ontology: OntologyRegistry
): AuthorizedOntologySelection {
  switch (authority.type) {
    case "unrestricted":
      return { kind: "all" }
    case "principal":
      return {
        kind: "types",
        objectTypeIds: ontology
          .listObjectTypes()
          .filter((objectType) =>
            isAllowed(authority.context, {
              kind: "object.view",
              objectTypeId: objectType.id,
            })
          )
          .map((objectType) => objectType.id),
      }
    case "delegated":
      return { kind: "selected", scope: authority.objectRead.scope }
  }
}

function delegatedLinkDefinitionKey(
  input:
    | Pick<CompiledObjectReadStep, "sourceObjectTypeId" | "linkId" | "targetObjectTypeId">
    | Pick<ObjectLinkRow, "sourceTypeId" | "linkId" | "targetTypeId">
): string {
  return "sourceObjectTypeId" in input
    ? JSON.stringify([input.sourceObjectTypeId, input.linkId, input.targetObjectTypeId])
    : JSON.stringify([input.sourceTypeId, input.linkId, input.targetTypeId])
}

/**
 * Storage providers may optimize trusted reads with live references. Values crossing the
 * application-facing authorization boundary must not retain them.
 */
function detachReadResult<T>(value: T): T {
  return structuredClone(value)
}

/** Capture caller-owned values before authorization and execution. */
function snapshotReadValue<T>(value: T): T {
  return structuredClone(value)
}

/** Bound and capture facet arguments before reading any caller-owned element. */
function snapshotFacetRequests(facets: readonly ObjectFacetRequest[]): ObjectFacetRequest[] {
  if (!Array.isArray(facets)) {
    throw new ObjectQueryValidationError([
      {
        path: "$.facets",
        code: "invalid_facets",
        message: "facets must be an array",
      },
    ])
  }
  const length = facets.length
  if (!Number.isSafeInteger(length) || length > MAX_OBJECT_READ_FACETS) {
    throw new ObjectQueryValidationError([
      {
        path: "$.facets",
        code: "too_many_facets",
        message: `facets must include at most ${MAX_OBJECT_READ_FACETS} facet requests`,
      },
    ])
  }

  const snapshot: ObjectFacetRequest[] = []
  for (let index = 0; index < length; index += 1) {
    const facet = facets[index]
    snapshot.push({ propertyId: facet.propertyId, limit: facet.limit })
  }
  return snapshot
}

/** Capture one serializable query before either authorization or execution sees it. */
function snapshotAuthoredQuery(query: ObjectQuery): ObjectQuery {
  try {
    const snapshot = structuredClone(query)
    const pending = [snapshot]
    const seen = new Set<ObjectQuery>()
    for (const node of pending) {
      if (seen.has(node)) continue
      seen.add(node)
      if (
        node.kind === "vector" &&
        (typeof node.vector !== "string" ||
          typeof node.profile !== "string" ||
          "propertyId" in node)
      ) {
        throw new ObjectQueryValidationError([
          {
            path: "$",
            code: "invalid_vector_search_input",
            message: "Vector search requires a named profile and search text",
          },
        ])
      }
      if ("input" in node) pending.push(node.input)
      if (node.kind === "set") pending.push(...node.inputs)
    }
    return snapshot
  } catch (error) {
    if (error instanceof ObjectQueryValidationError) throw error
    throw new ObjectQueryValidationError([
      {
        path: "$",
        code: "query_not_cloneable",
        message: "Object query must contain only structured-cloneable data",
      },
    ])
  }
}
