import { assertAuthorized, isAllowed } from "../authorization"
import { AuthorizationError } from "../authorization/errors"
import type { AuthorizationContext } from "../authorization/types"
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
import { assertObjectQueryComplexity } from "../objects/query/complexity"
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
  validateObjectQuery,
  validateObjectQueryWithAdmission,
} from "../objects/query/validate"
import type { OntologyRegistry } from "../ontology"
import type {
  CompiledObjectReadStep,
  LinkBatchKey,
  ObjectFacetRequest,
  ObjectLinkRow,
  ObjectReadStorage,
  ObjectStorage,
} from "../storage"
import { MAX_OBJECT_READ_FACETS } from "../storage"
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
  readonly #storage: ObjectReadStorage
  readonly #delegatedObjectTypeIds?: ReadonlySet<string>
  readonly #delegatedLinkDefinitions?: ReadonlySet<string>
  readonly #delegatedQueryAdmission?: SelectedObjectQueryAdmission

  constructor(
    key: typeof readerConstructionKey,
    input: {
      readonly scope: ExecutionScope
      readonly ontology: OntologyRegistry
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
    return detachReadResult(
      await this.#storage.getByPrimaryId({
        ...request,
        projectId: this.#runtime.projectId,
      })
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
    this.#assertObjectTypesViewable(request.items.map((item) => item.objectTypeId))
    return detachReadResult(
      await this.#storage.getByPrimaryIdBatch({
        ...request,
        projectId: this.#runtime.projectId,
      })
    )
  }

  async canReadObjectProperty(input: CanReadObjectPropertyInput): Promise<boolean> {
    const request = snapshotReadValue({
      objectTypeId: input.objectTypeId,
      primaryId: input.primaryId,
      propertyId: input.propertyId,
    })
    this.#assertObjectTypesViewable([request.objectTypeId])
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
    return detachReadResult(
      await this.#storage.selectsObjectProperties({
        ...request,
        projectId: this.#runtime.projectId,
      })
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

    return detachReadResult(
      await this.#storage.list({
        ...request,
        ...(objectTypeId === undefined ? {} : { objectTypeId }),
        projectId: this.#runtime.projectId,
      })
    )
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
    return detachReadResult(
      await executeObjectQuery(
        {
          query: executionQuery,
          ...(includeTotal === undefined ? {} : { includeTotal }),
          projectId: this.#runtime.projectId,
        },
        this.#queryExecutorOptions()
      )
    )
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
    return result
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

  #queryExecutorOptions() {
    if (this.#authority.type === "delegated") {
      // The selected storage instance is the private execution capability. Passing the delegated
      // runtime token into the generic executor would either reject this admitted query or tempt a
      // forgeable bypass flag; neither is needed at this nominal boundary.
      return { ontology: this.#ontology, storage: this.#storage }
    }
    return {
      ontology: this.#ontology,
      storage: this.#storage,
      runtimeAuthorization: this.#runtime.runtimeAuthorization,
      ...(this.#runtime.authorization === undefined
        ? {}
        : { authorization: this.#runtime.authorization }),
    }
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
  readonly objectStorage: ObjectStorage
}): AuthorizedObjectReader {
  const scope = captureExecutionScope(input.scope)
  const projectId = scope.execution.projectId
  const authority = resolveExecutionScopeAuthorization(projectId, scope)
  const storage = objectStorageForAuthority(authority, input.objectStorage)
  const reader = new AuthorizedObjectReaderImpl(readerConstructionKey, {
    scope,
    ontology: input.ontology,
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
  }
  return assertNever(authority)
}

function assertNever(value: never): never {
  throw new Error(
    `[Sixb] Unsupported object reader authority '${String((value as { type?: unknown }).type)}'.`
  )
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

/**
 * Capture one bounded, serializable query before either authorization or execution sees it. The
 * second structural check handles getter-backed inputs whose shape changes while being cloned.
 */
function snapshotAuthoredQuery(query: ObjectQuery): ObjectQuery {
  assertObjectQueryComplexity(query)
  try {
    const snapshot = structuredClone(query)
    assertObjectQueryComplexity(snapshot)
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
