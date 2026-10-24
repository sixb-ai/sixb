import { assertNever } from "../assert-never"
import { isRuntimeAllowed } from "../authorization"
import { AuthorizationError } from "../authorization/errors"
import type { EmbeddingModelCatalog, RerankingModelCatalog } from "../models/catalog"
import type { AuthorizedOntologyView } from "../objects/authorized-ontology-view"
import {
  attachRedactions,
  omitHiddenProperties,
  redactObjectRow,
} from "../objects/clearance-redaction"
import { unreadableError } from "../objects/property-clearance"
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
import { createClearanceQueryAdmission } from "../objects/query/clearance-admission"
import { ObjectQueryValidationError } from "../objects/query/errors"
import { type QueryExecutorOptions, validateObjectFacetRequests } from "../objects/query/executor"
import type { ObjectQuery } from "../objects/query/ir"
import { assertLinkQueryReadable } from "../objects/query/link-query-clearance"
import { preflightObjectQueryLinks } from "../objects/query/links"
import { normalizeObjectQuery } from "../objects/query/normalize"
import { userExpansionPlan } from "../objects/query/user-expansions"
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
import type { AppliedMarkings } from "../security/applied-markings"
import type {
  AuthUserStore,
  LinkBatchKey,
  ObjectFacetRequest,
  ObjectLinkRow,
  ObjectReadStorage,
  ObjectRow,
  ObjectStorage,
} from "../storage"
import { assertObjectReadOutputWithinLimit, MAX_OBJECT_READ_FACETS } from "../storage"
import { captureExecutionScope, resolveExecutionScopeAuthorization } from "./authorization"
import type { Clearance, EventSources } from "./object-reader-clearance"
import { ObjectReaderOntology } from "./object-reader-ontology"
import { ObjectReaderSecurity } from "./object-reader-security"
import { attachUserProfiles } from "./object-reader-users"
import type { ExecutionScope } from "./types"
import { uniqueLookupKey } from "./unique-lookup"

type GetObjectInput = Omit<Parameters<ObjectReadStorage["getByPrimaryId"]>[0], "projectId">
type GetObjectsInput = Omit<Parameters<ObjectReadStorage["getByPrimaryIdBatch"]>[0], "projectId">
/** A caller's value, validated and keyed against the property's schema. */
interface GetByUniqueValueInput {
  readonly objectTypeId: string
  readonly propertyId: string
  readonly value: unknown
}
type SelectObjectPropertiesInput = Parameters<ObjectReadStorage["selectsObjectProperties"]>[0]
type CanReadObjectPropertyInput = SelectObjectPropertiesInput["items"][number]
type CanReadObjectPropertiesBatchInput = Omit<SelectObjectPropertiesInput, "projectId">
type ListObjectsInput = Omit<Parameters<ObjectReadStorage["list"]>[0], "projectId">
type ListLinksInput = Omit<Parameters<ObjectReadStorage["listLinks"]>[0], "projectId">
type ListLinksBatchInput = Omit<Parameters<ObjectReadStorage["listLinksBatch"]>[0], "projectId">

/** The model catalogs semantic and reranked search use. */
interface ObjectReaderModels {
  readonly embedding?: EmbeddingModelCatalog
  readonly reranking?: RerankingModelCatalog
}

const readerConstructionKey = Object.freeze({})

/**
 * Core-owned object read boundary for one exact execution authority.
 *
 * The implementation class is intentionally private to this module. Its private fields make the
 * exported instance type nominal, while the construction key prevents code that discovers the
 * JavaScript constructor through an instance from manufacturing another reader.
 *
 * Its state is grouped as a project is: the ontology it resolves against, the security of the
 * authority (its delegation and clearance included), the model catalogs search uses, and the
 * storage it reads, with the member directory that expanded user properties resolve against.
 * Each group decides what belongs to it; the reader composes them.
 */
class AuthorizedObjectReaderImpl {
  readonly #ontology: ObjectReaderOntology
  readonly #security: ObjectReaderSecurity
  readonly #models: ObjectReaderModels
  readonly #storage: ObjectReadStorage
  readonly #users: AuthUserStore | undefined

  constructor(
    key: typeof readerConstructionKey,
    input: {
      readonly ontology: ObjectReaderOntology
      readonly security: ObjectReaderSecurity
      readonly models: ObjectReaderModels
      readonly storage: ObjectReadStorage
      readonly users?: AuthUserStore
    }
  ) {
    if (key !== readerConstructionKey) {
      throw new Error("[Sixb] AuthorizedObjectReader can only be created by Core.")
    }
    this.#ontology = input.ontology
    this.#security = input.security
    this.#models = input.models
    this.#storage = input.storage
    this.#users = input.users
  }

  static assertBound(reader: AuthorizedObjectReaderImpl, scope: ExecutionScope): void {
    const capturedScope = captureExecutionScope(scope)
    resolveExecutionScopeAuthorization(reader.#security.runtime.projectId, capturedScope)
    if (capturedScope.authorization !== reader.#security.authorization) {
      throw new Error(
        "[Sixb] AuthorizedObjectReader is not bound to this exact execution authority."
      )
    }
  }

  /** What the reader cannot read now, for surfaces such as events that redact on their own. */
  static async clearance(reader: AuthorizedObjectReaderImpl): Promise<Clearance> {
    return reader.#security.clearance.current()
  }

  /** What the reader cannot read in an object event. */
  static eventClearance(
    reader: AuthorizedObjectReaderImpl,
    sources: EventSources
  ): Clearance | Promise<Clearance> {
    return reader.#security.clearance.forEvent(sources)
  }

  static ontologyView(reader: AuthorizedObjectReaderImpl): AuthorizedOntologyView {
    return reader.#ontology.view()
  }

  /** Project identity carried by this nominal reader capability. */
  get projectId(): string {
    return this.#security.runtime.projectId
  }

  async getByPrimaryId(input: GetObjectInput): ReturnType<ObjectReadStorage["getByPrimaryId"]> {
    const request = snapshotReadValue({
      objectTypeId: input.objectTypeId,
      primaryId: input.primaryId,
    })
    const clearance = await this.#security.clearance.current()
    this.#security.assertObjectTypesViewable([request.objectTypeId], clearance)
    const row = await this.#storage.getByPrimaryId({
      ...request,
      projectId: this.#security.runtime.projectId,
    })
    return this.#detachRows(
      row && this.#omitHidden(row, clearance),
      (detached) => [detached],
      clearance
    )
  }

  /**
   * The object of exactly `objectTypeId` holding a unique property's value, or null. A lookup by a
   * marked property would reveal its value, so it needs the clearance a query predicate needs.
   */
  async getByUniqueValue(input: GetByUniqueValueInput): Promise<ObjectRow | null> {
    const request = snapshotReadValue({
      objectTypeId: input.objectTypeId,
      propertyId: input.propertyId,
      value: input.value,
    })
    const clearance = await this.#security.clearance.current()
    this.#security.assertObjectTypesViewable([request.objectTypeId], clearance)

    const valueKey = uniqueLookupKey(this.#ontology.registry, request)
    const marking = clearance?.missingMarking(request.objectTypeId, request.propertyId)
    if (marking !== undefined) {
      throw new AuthorizationError(
        `clearance:marking:${marking}`,
        `[Sixb] Cannot look up '${request.objectTypeId}.${request.propertyId}' by value: it requires clearance for marking '${marking}'.`
      )
    }

    const row = await this.#storage.getByUniqueValue({
      objectTypeId: request.objectTypeId,
      propertyId: request.propertyId,
      valueKey,
      projectId: this.#security.runtime.projectId,
    })
    return this.#detachRows(
      row && this.#omitHidden(row, clearance),
      (detached) => [detached],
      clearance
    )
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
    const clearance = await this.#security.clearance.current()
    this.#security.assertObjectTypesViewable(
      request.items.map((item) => item.objectTypeId),
      clearance
    )
    const rows = await this.#storage.getByPrimaryIdBatch({
      ...request,
      projectId: this.#security.runtime.projectId,
    })
    return this.#detachRows(
      new Map([...rows].map(([key, row]) => [key, this.#omitHidden(row, clearance)] as const)),
      (detached) => detached.values(),
      clearance
    )
  }

  async canReadObjectProperty(input: CanReadObjectPropertyInput): Promise<boolean> {
    const request = snapshotReadValue({
      objectTypeId: input.objectTypeId,
      primaryId: input.primaryId,
      propertyId: input.propertyId,
    })
    const clearance = await this.#security.clearance.current()
    this.#security.assertObjectTypesViewable([request.objectTypeId], clearance, {
      everyObject: true,
    })

    if (hidesProperty(request, clearance)) return false
    if (this.#security.authority.type !== "delegated") return true
    const [readable] = await this.#storage.selectsObjectProperties({
      projectId: this.#security.runtime.projectId,
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
    const clearance = await this.#security.clearance.current()
    this.#security.assertObjectTypesViewable(
      request.items.map((item) => item.objectTypeId),
      clearance,
      { everyObject: true }
    )
    const selected =
      this.#security.authority.type === "delegated"
        ? await this.#storage.selectsObjectProperties({
            ...request,
            projectId: this.#security.runtime.projectId,
          })
        : request.items.map(() => true)
    return request.items.map(
      (item, index) => !hidesProperty(item, clearance) && selected[index] === true
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
    const clearance = await this.#security.clearance.current()
    const objectTypeId = this.#resolveListObjectTypes(request.objectTypeId, clearance)

    // An empty type selection means "none", never "all". Short-circuiting here prevents a
    // provider with different empty-array semantics from turning a principal read into a broad one.
    if (Array.isArray(objectTypeId) && objectTypeId.length === 0) {
      return { objects: [], hasMore: false, total: 0 }
    }

    const page = await this.#storage.list({
      ...request,
      ...(objectTypeId === undefined ? {} : { objectTypeId }),
      projectId: this.#security.runtime.projectId,
    })
    return this.#detachRows(
      { ...page, objects: page.objects.map((row) => this.#omitHidden(row, clearance)) },
      (detached) => detached.objects,
      clearance
    )
  }

  async listLinks(input: ListLinksInput): ReturnType<ObjectReadStorage["listLinks"]> {
    const request = snapshotReadValue({
      objectTypeId: input.objectTypeId,
      objectId: input.objectId,
      linkId: input.linkId,
      direction: input.direction,
    })
    const clearance = await this.#security.clearance.current()
    this.#security.assertObjectTypesViewable([request.objectTypeId], clearance)
    const links = detachReadResult(
      await this.#storage.listLinks({
        ...request,
        projectId: this.#security.runtime.projectId,
      })
    )
    return links.filter((link) => this.#security.isLinkViewable(link, clearance))
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
    const clearance = await this.#security.clearance.current()
    this.#security.assertObjectTypesViewable(
      request.items.map((item) => item.objectTypeId),
      clearance
    )
    const pages = detachReadResult(
      await this.#storage.listLinksBatch({
        ...request,
        projectId: this.#security.runtime.projectId,
      })
    )
    const filtered = new Map<LinkBatchKey, ObjectLinkRow[]>()
    for (const [key, links] of pages) {
      filtered.set(
        key,
        links.filter((link) => this.#security.isLinkViewable(link, clearance))
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
    const clearance = await this.#security.clearance.current()
    const result = await executeObjectQuery(
      {
        query: executionQuery,
        ...(includeTotal === undefined ? {} : { includeTotal }),
        projectId: this.#security.runtime.projectId,
        signal: input.signal,
      },
      this.#queryExecutorOptions(clearance)
    )
    const detached = this.#detachRows(
      { ...result, objects: result.objects.map((row) => this.#omitHidden(row, clearance)) },
      (detached) => detached.objects,
      clearance
    )

    await this.#attachUsers(detached.objects, query)
    return detached
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
    const admission = this.#security.delegation?.queryAdmission
    if (admission) {
      const preflight = preflightObjectQueryLinks(
        { query, ...request, projectId: this.#security.runtime.projectId },
        { ontology: this.#ontology.registry }
      )
      const admitted = validateObjectQueryWithAdmission(
        preflight.validated.query,
        { ontology: this.#ontology.registry, normalize: false },
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

    const clearance = await this.#security.clearance.current()
    if (clearance) {
      assertLinkQueryReadable({
        ontology: this.#ontology.registry,
        clearance,
        query,
        request: { ...request, projectId: this.#security.runtime.projectId },
        viewableByGrants: (objectTypeId) =>
          this.#security.isObjectTypeViewable(objectTypeId, undefined),
      })
    }

    const result = detachReadResult(
      await executeObjectQueryLinks(
        { query: executionQuery, ...request, projectId: this.#security.runtime.projectId },
        this.#queryExecutorOptions(clearance)
      )
    )

    // Link pagination is computed by the provider-facing executor. Filtering afterward would make
    // its cursor and hasMore metadata describe hidden rows, so a provider contract violation must
    // fail closed instead of returning a partially filtered page.
    if (
      result.objects.some(
        (row) => !this.#security.isObjectTypeViewable(row.objectTypeId, clearance)
      ) ||
      result.links.some((link) => !this.#security.isLinkViewable(link, clearance))
    ) {
      throw new Error("[Sixb] Object storage returned a link page outside its authorized scope.")
    }

    return {
      ...result,
      objects: result.objects.map((row) => (clearance ? redactObjectRow(row, clearance) : row)),
    }
  }

  async count(
    input: Omit<ExecuteObjectCountInput, "projectId">
  ): Promise<ExecuteObjectCountResult> {
    const query = snapshotAuthoredQuery(input.query)
    const executionQuery = this.#admitDelegatedQuery(query)?.query ?? query
    const clearance = await this.#security.clearance.current()
    return detachReadResult(
      await countObjects(
        { query: executionQuery, projectId: this.#security.runtime.projectId },
        this.#queryExecutorOptions(clearance)
      )
    )
  }

  async exists(
    input: Omit<ExecuteObjectExistsInput, "projectId">
  ): Promise<ExecuteObjectExistsResult> {
    const query = snapshotAuthoredQuery(input.query)
    const executionQuery = this.#admitDelegatedQuery(query)?.query ?? query
    const clearance = await this.#security.clearance.current()
    return detachReadResult(
      await existsObjects(
        { query: executionQuery, projectId: this.#security.runtime.projectId },
        this.#queryExecutorOptions(clearance)
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
    const admission = this.#security.delegation?.queryAdmission
    if (admission) {
      // Terminal arguments are ordinary validation errors, not an authorization oracle. Validate
      // them against the canonical result shape before raising any delegated-scope denial.
      const validated = validateObjectQuery(query, { ontology: this.#ontology.registry })
      const normalizedFacets = validateObjectFacetRequests(facets, validated.result.objectTypeIds, {
        ontology: this.#ontology.registry,
      })
      const admitted = validateObjectQueryWithAdmission(
        validated.query,
        { ontology: this.#ontology.registry, normalize: false },
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
    const clearance = await this.#security.clearance.current()
    return detachReadResult(
      await facetObjects(
        {
          query: executionQuery,
          facets: executionFacets,
          projectId: this.#security.runtime.projectId,
        },
        this.#queryExecutorOptions(clearance)
      )
    )
  }

  /**
   * Redact the rows a write of this object type returns. An upsert returns the merged effective
   * row, which may hold marked values the writer never sent and cannot read. Resolved before the
   * write, which it refuses when the writer cannot read the type at all.
   */
  async writtenRowRedactor(
    objectTypeId: string
  ): Promise<<TRow extends ObjectRow>(row: TRow) => TRow> {
    const clearance = await this.#security.clearance.current()
    assertTargetsReadable(clearance, { objectTypeIds: [objectTypeId] })
    return (row) => (clearance ? redactObjectRow(row, clearance) : row)
  }

  /**
   * The check a direct write runs on each object's properties before its commit claims them. It
   * refuses a value for a unique property this authority cannot read: whether the write is refused
   * as taken would reveal which values objects hold, as a `getBy` would.
   */
  async uniqueValueWriteCheck(
    objectTypeId: string
  ): Promise<(properties: Readonly<Record<string, unknown>>) => void> {
    const clearance = await this.#security.clearance.current()
    const marked = this.#ontology.registry
      .listUniqueProperties(objectTypeId)
      .flatMap((property) => {
        const marking = clearance?.missingMarking(objectTypeId, property.propertyId)
        return marking === undefined ? [] : [{ propertyId: property.propertyId, marking }]
      })

    return (properties) => {
      for (const { propertyId, marking } of marked) {
        if (properties[propertyId] === undefined || properties[propertyId] === null) continue

        throw new AuthorizationError(
          `clearance:marking:${marking}`,
          `[Sixb] Cannot write a value to '${objectTypeId}.${propertyId}': it is unique and requires clearance for marking '${marking}'.`
        )
      }
    }
  }

  /**
   * Refuse a write or a request that names an object type or link this authority cannot read,
   * before any lookup: it would answer whether what it names exists, and land where the reader
   * cannot see.
   */
  async assertReadable(targets: ReadTargets): Promise<void> {
    assertTargetsReadable(await this.#security.clearance.current(), targets)
  }

  /** Enforce the delegated response budget without exposing or recombining its limits. */
  assertVisibleOutputWithinLimit(value: unknown): void {
    if (this.#security.authority.type !== "delegated") return
    assertObjectReadOutputWithinLimit(value, this.#security.authority.objectRead.limits)
  }

  /** Admit adjacent telemetry work without exposing which authority policy was selected. */
  admitTelemetryHistoryRead(
    input: TelemetryHistoryReadWorkloadInput
  ): TelemetryHistoryReadAdmission {
    return admitTelemetryHistoryReadWorkload(input, this.#security.authority.type === "delegated")
  }

  #queryExecutorOptions(clearance: Clearance) {
    const admission = this.#executorAdmission(clearance)

    if (this.#security.authority.type === "delegated") {
      // The selected storage instance is the private execution capability. Passing the delegated
      // runtime token into the generic executor would either reject this admitted query or tempt a
      // forgeable bypass flag; neither is needed at this nominal boundary.
      return {
        ontology: this.#ontology.registry,
        storage: this.#storage,
        embeddingModels: this.#models.embedding,
        rerankingModels: this.#models.reranking,
        ...(admission === undefined ? {} : { admission }),
        requestingUser: this.#security.requestingUser,
      }
    }
    return {
      ontology: this.#ontology.registry,
      embeddingModels: this.#models.embedding,
      rerankingModels: this.#models.reranking,
      storage: this.#storage,
      ...this.#queryAuthorization(clearance),
      ...(admission === undefined ? {} : { admission }),
      requestingUser: this.#security.requestingUser,
    }
  }

  /**
   * A principal's queries read the types this reader's security grants, including those its
   * storage reads through a condition, which no view grant holds.
   */
  #queryAuthorization(
    clearance: Clearance
  ): Pick<QueryExecutorOptions, "readableObjectTypes" | "runtimeAuthorization"> {
    const runtimeAuthorization = this.#security.runtime.runtimeAuthorization
    if (this.#security.authority.type !== "principal") return { runtimeAuthorization }

    const security = this.#security
    return {
      runtimeAuthorization,
      readableObjectTypes: Object.freeze({
        assert: (objectTypeIds: readonly string[]) =>
          security.assertObjectTypesGranted(objectTypeIds, clearance),
        has: (objectTypeId: string) => security.isObjectTypeGranted(objectTypeId, clearance),
      }),
    }
  }

  /**
   * The executor validates the query it runs, and that validation resolves default text fields.
   * Every admission that narrows those fields must therefore apply there, not only beforehand.
   */
  #executorAdmission(clearance: Clearance): ObjectQuerySemanticAdmission | undefined {
    const admission = clearance && createClearanceQueryAdmission(clearance)
    const selected = this.#security.delegation?.queryAdmission

    if (selected && admission) return composeObjectQueryAdmissions(selected, admission)
    return selected ?? admission
  }

  /**
   * Resolve the user properties the query expands on rows already detached and redacted. Only an
   * authority that may view the directory reads profiles; a delegated one never does.
   */
  async #attachUsers(rows: readonly ObjectRow[], query: ObjectQuery): Promise<void> {
    const plan = userExpansionPlan(normalizeObjectQuery(query))
    if (!plan) return

    await attachUserProfiles({
      rows,
      plan,
      ontology: this.#ontology.registry,
      projectId: this.#security.runtime.projectId,
      canViewUsers: isRuntimeAllowed(this.#security.runtime, { kind: "users.view" }),
      users: this.#users,
    })
  }

  #omitHidden<TRow extends ObjectRow>(row: TRow, clearance: Clearance): TRow {
    return clearance ? omitHiddenProperties(row, clearance) : row
  }

  /**
   * Detach a result whose rows went through {@link #omitHidden}, then list their redactions on
   * the copy. Each row is deep-copied once, and never with a hidden value.
   */
  #detachRows<TResult>(
    result: TResult,
    rows: (detached: TResult) => Iterable<ObjectRow | null>,
    clearance: Clearance
  ): TResult {
    const detached = detachReadResult(result)
    if (clearance) {
      for (const row of rows(detached)) if (row) attachRedactions(row, clearance)
    }

    return detached
  }

  #admitDelegatedQuery(query: ObjectQuery): AdmittedObjectQuery | undefined {
    const admission = this.#security.delegation?.queryAdmission
    if (!admission) return undefined
    return validateObjectQueryWithAdmission(query, { ontology: this.#ontology.registry }, admission)
  }

  #resolveListObjectTypes(
    requested: ListObjectsInput["objectTypeId"],
    clearance: Clearance
  ): ListObjectsInput["objectTypeId"] {
    if (requested !== undefined) {
      const objectTypeIds = typeof requested === "string" ? [requested] : [...new Set(requested)]
      for (const objectTypeId of objectTypeIds) {
        this.#ontology.registry.resolveObjectType(objectTypeId)
      }
      this.#security.assertObjectTypesViewable(objectTypeIds, clearance)
      return typeof requested === "string" ? requested : objectTypeIds
    }

    if (this.#security.authority.type === "unrestricted") return undefined
    return this.#ontology.registry
      .listObjectTypes()
      .map((objectType) => objectType.id)
      .filter((objectTypeId) => this.#security.isObjectTypeViewable(objectTypeId, clearance))
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
  /** Markings of the dataset versions projections applied; the code's markings alone without. */
  readonly appliedMarkings?: AppliedMarkings
  /** The member directory expanded user properties resolve against. */
  readonly users?: AuthUserStore
}): AuthorizedObjectReader {
  const scope = captureExecutionScope(input.scope)
  const projectId = scope.execution.projectId
  const authority = resolveExecutionScopeAuthorization(projectId, scope)
  const security = new ObjectReaderSecurity({
    authorization: scope.authorization,
    authority,
    projectId,
    ontology: input.ontology,
    ...(input.appliedMarkings === undefined ? {} : { appliedMarkings: input.appliedMarkings }),
    requestedBy: scope.execution.requestedBy,
  })
  const storage = objectStorageForAuthority(security, input.objectStorage)
  const reader = new AuthorizedObjectReaderImpl(readerConstructionKey, {
    ontology: new ObjectReaderOntology(input.ontology, security),
    security,
    models: Object.freeze({
      ...(input.embeddingModels === undefined ? {} : { embedding: input.embeddingModels }),
      ...(input.rerankingModels === undefined ? {} : { reranking: input.rerankingModels }),
    }),
    storage,
    ...(input.users === undefined ? {} : { users: input.users }),
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
 * What a reader resolved for this authority cannot read now. Events redact with it: an event of an
 * object type the reader cannot read is not delivered, and the others are redacted like rows.
 */
export function readerClearance(reader: AuthorizedObjectReader): Promise<Clearance> {
  return AuthorizedObjectReaderImpl.clearance(reader)
}

/**
 * What a reader cannot read in an object event: the current markings, with those of the versions
 * its values came from. A plain value for a reader those markings cannot affect, which reads no
 * version.
 */
export function readerEventClearance(
  reader: AuthorizedObjectReader,
  sources: EventSources
): Clearance | Promise<Clearance> {
  return AuthorizedObjectReaderImpl.eventClearance(reader, sources)
}

/** What a write or a request names: object types, and links by their source type. */
interface ReadTargets {
  readonly objectTypeIds: readonly string[]
  readonly links?: readonly { readonly objectTypeId: string; readonly linkId: string }[]
}

function assertTargetsReadable(clearance: Clearance, targets: ReadTargets): void {
  if (!clearance) return

  for (const objectTypeId of targets.objectTypeIds) {
    const unreadable = clearance.unreadableType(objectTypeId)
    if (unreadable) throw unreadableError(unreadable)
  }

  for (const link of targets.links ?? []) {
    const unreadable = clearance.unreadableLink(link.objectTypeId, link.linkId)
    if (unreadable) throw unreadableError(unreadable)
  }
}

function hidesProperty(
  item: { readonly objectTypeId: string; readonly propertyId: string },
  clearance: Clearance
): boolean {
  return clearance?.missingMarking(item.objectTypeId, item.propertyId) !== undefined
}

function objectStorageForAuthority(
  security: ObjectReaderSecurity,
  objectStorage: ObjectStorage
): ObjectReadStorage {
  const authority = security.authority

  switch (authority.type) {
    case "principal":
      return security.conditionalScope
        ? objectStorage.createConditionalReadScope({
            projectId: authority.projectId,
            scope: security.conditionalScope,
          })
        : objectStorage
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
