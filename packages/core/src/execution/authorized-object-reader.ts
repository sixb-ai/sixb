import { assertAuthorized, assertCanReadObjectProperty, isRuntimeAllowed } from "../authorization"
import { objectReadScopeForAccessPlan } from "../authorization/access-plan"
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
  type ExecuteObjectQueryResult,
  executeObjectQuery,
  existsObjects,
  facetObjects,
} from "../objects/query"
import { assertObjectQueryComplexity } from "../objects/query/complexity"
import { ObjectQueryValidationError } from "../objects/query/errors"
import type { ObjectQuery } from "../objects/query/ir"
import { assertObjectQueryAuthorizedByAccessPlan } from "../objects/query/read-scope-authorization"
import { validateObjectQuery } from "../objects/query/validate"
import type { OntologyRegistry } from "../ontology"
import type { ObjectReadStorage, ObjectStorage } from "../storage"
import { resolveExecutionScopeAuthorization } from "./authorization"
import type { DelegatedExecutionLimits } from "./limits"
import type { ExecutionScope, RuntimeAuthorization } from "./types"

type RuntimeReadAuthorization = {
  readonly projectId: string
  readonly runtimeAuthorization: RuntimeAuthorization
  readonly authorization?: AuthorizationContext
}

type GetObjectInput = Omit<Parameters<ObjectReadStorage["getByPrimaryId"]>[0], "projectId">
type GetObjectsInput = Omit<Parameters<ObjectReadStorage["getByPrimaryIdMany"]>[0], "projectId">
type ListObjectsInput = Omit<Parameters<ObjectReadStorage["list"]>[0], "projectId">
type ListLinksInput = Omit<Parameters<ObjectReadStorage["listLinks"]>[0], "projectId">
type ListLinksManyInput = Omit<Parameters<ObjectReadStorage["listLinksMany"]>[0], "projectId">
type SelectObjectPropertiesInput = Parameters<ObjectReadStorage["selectsObjectProperties"]>[0]
type CanReadObjectPropertyInput = SelectObjectPropertiesInput["items"][number]
type CanReadObjectPropertiesInput = Omit<SelectObjectPropertiesInput, "projectId">

/**
 * Core-owned object read boundary for one exact execution authority.
 *
 * The implementation class is intentionally not exported. Its private field keeps the public
 * type nominal, while the factory is the only place that can pair an execution with its provider
 * scope. Application code never receives the storage-level read scope directly.
 */
class AuthorizedObjectReaderImpl {
  readonly #scope: ExecutionScope
  readonly #authority: ReturnType<typeof resolveExecutionScopeAuthorization>
  readonly #runtime: RuntimeReadAuthorization
  readonly #ontology: OntologyRegistry
  readonly #storage: ObjectReadStorage

  constructor(input: {
    readonly scope: ExecutionScope
    readonly ontology: OntologyRegistry
    readonly storage: ObjectReadStorage
    readonly authority: ReturnType<typeof resolveExecutionScopeAuthorization>
  }) {
    this.#scope = input.scope
    this.#authority = input.authority
    this.#ontology = input.ontology
    this.#storage = input.storage
    this.#runtime = Object.freeze({
      projectId: input.scope.execution.projectId,
      runtimeAuthorization: input.scope.authorization,
      ...(input.authority.type === "principal" ? { authorization: input.authority.context } : {}),
    })
  }

  assertBound(scope: ExecutionScope): void {
    resolveExecutionScopeAuthorization(this.#runtime.projectId, scope)
    if (scope.authorization !== this.#scope.authorization) {
      throw new Error(
        "[Sixb] AuthorizedObjectReader is not bound to this exact execution authority."
      )
    }
  }

  /** Project identity carried by this nominal reader capability. */
  get projectId(): string {
    return this.#runtime.projectId
  }

  async getByPrimaryId(input: GetObjectInput) {
    const request = snapshotReadValue({
      objectTypeId: input.objectTypeId,
      primaryId: input.primaryId,
    })
    assertAuthorized(this.#runtime, { kind: "object.view", objectTypeId: request.objectTypeId })
    return detachReadResult(
      await this.#storage.getByPrimaryId({ ...request, projectId: this.#runtime.projectId })
    )
  }

  async getByPrimaryIdMany(input: GetObjectsInput) {
    const request = snapshotReadValue({
      items: input.items.map((item) => ({
        objectTypeId: item.objectTypeId,
        primaryId: item.primaryId,
      })),
    })
    for (const objectTypeId of new Set(request.items.map((item) => item.objectTypeId))) {
      assertAuthorized(this.#runtime, { kind: "object.view", objectTypeId })
    }
    return detachReadResult(
      await this.#storage.getByPrimaryIdMany({
        ...request,
        projectId: this.#runtime.projectId,
      })
    )
  }

  async list(input: ListObjectsInput) {
    const requestedObjectTypeId = input.objectTypeId
    const request = snapshotReadValue({
      objectTypeId:
        typeof requestedObjectTypeId === "string"
          ? requestedObjectTypeId
          : requestedObjectTypeId === undefined
            ? undefined
            : [...requestedObjectTypeId],
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
    return detachReadResult(
      await this.#storage.list({
        ...request,
        ...(objectTypeId === undefined ? {} : { objectTypeId }),
        projectId: this.#runtime.projectId,
      })
    )
  }

  async listLinks(input: ListLinksInput) {
    const request = snapshotReadValue({
      objectTypeId: input.objectTypeId,
      objectId: input.objectId,
      linkId: input.linkId,
      direction: input.direction,
    })
    assertAuthorized(this.#runtime, { kind: "object.view", objectTypeId: request.objectTypeId })
    const links = await this.#storage.listLinks({
      ...request,
      projectId: this.#runtime.projectId,
    })
    return detachReadResult(
      links.filter(
        (link) =>
          isRuntimeAllowed(this.#runtime, {
            kind: "object.view",
            objectTypeId: link.sourceTypeId,
          }) &&
          isRuntimeAllowed(this.#runtime, {
            kind: "object.view",
            objectTypeId: link.targetTypeId,
          })
      )
    )
  }

  async listLinksMany(input: ListLinksManyInput) {
    const request = snapshotReadValue({
      direction: input.direction,
      items: input.items.map((item) => ({
        objectTypeId: item.objectTypeId,
        objectId: item.objectId,
        linkId: item.linkId,
      })),
    })
    for (const objectTypeId of new Set(request.items.map((item) => item.objectTypeId))) {
      assertAuthorized(this.#runtime, { kind: "object.view", objectTypeId })
    }
    const links = await this.#storage.listLinksMany({
      ...request,
      projectId: this.#runtime.projectId,
    })
    return detachReadResult(
      links.map((rows) =>
        rows.filter(
          (link) =>
            isRuntimeAllowed(this.#runtime, {
              kind: "object.view",
              objectTypeId: link.sourceTypeId,
            }) &&
            isRuntimeAllowed(this.#runtime, {
              kind: "object.view",
              objectTypeId: link.targetTypeId,
            })
        )
      )
    )
  }

  async canReadObjectProperty(input: CanReadObjectPropertyInput): Promise<boolean> {
    const request = snapshotReadValue({
      objectTypeId: input.objectTypeId,
      primaryId: input.primaryId,
      propertyId: input.propertyId,
    })
    assertCanReadObjectProperty(this.#runtime, request.objectTypeId, request.propertyId)
    if (this.#authority.type !== "delegated") return true
    const [selected] = await this.#storage.selectsObjectProperties({
      projectId: this.#runtime.projectId,
      items: [request],
    })
    return selected ?? false
  }

  async canReadObjectPropertiesMany(
    input: CanReadObjectPropertiesInput
  ): Promise<readonly boolean[]> {
    const request = snapshotReadValue({
      items: input.items.map((item) => ({
        objectTypeId: item.objectTypeId,
        primaryId: item.primaryId,
        propertyId: item.propertyId,
      })),
    })
    for (const item of request.items) {
      assertCanReadObjectProperty(this.#runtime, item.objectTypeId, item.propertyId)
    }
    if (this.#authority.type !== "delegated") return request.items.map(() => true)
    return detachReadResult(
      await this.#storage.selectsObjectProperties({
        ...request,
        projectId: this.#runtime.projectId,
      })
    )
  }

  async executeQuery(
    input: Omit<ExecuteObjectQueryInput, "projectId">
  ): Promise<ExecuteObjectQueryResult> {
    const query = this.#prepareAuthorizedQuery(input.query)
    const includeTotal = input.includeTotal
    return detachReadResult(
      await executeObjectQuery(
        {
          query,
          ...(includeTotal === undefined ? {} : { includeTotal }),
          projectId: this.#runtime.projectId,
        },
        this.#queryExecutorOptions()
      )
    )
  }

  async count(
    input: Omit<ExecuteObjectCountInput, "projectId">
  ): Promise<ExecuteObjectCountResult> {
    const query = this.#prepareAuthorizedQuery(input.query)
    return detachReadResult(
      await countObjects(
        { query, projectId: this.#runtime.projectId },
        this.#queryExecutorOptions()
      )
    )
  }

  async exists(
    input: Omit<ExecuteObjectExistsInput, "projectId">
  ): Promise<ExecuteObjectExistsResult> {
    const query = this.#prepareAuthorizedQuery(input.query)
    return detachReadResult(
      await existsObjects(
        { query, projectId: this.#runtime.projectId },
        this.#queryExecutorOptions()
      )
    )
  }

  async facet(
    input: Omit<ExecuteObjectFacetsInput, "projectId">
  ): Promise<ExecuteObjectFacetsResult> {
    const facets = snapshotReadValue(
      input.facets.map((facet) => ({ propertyId: facet.propertyId, limit: facet.limit }))
    )
    const query = this.#prepareAuthorizedQuery(
      input.query,
      facets.map((facet) => facet.propertyId)
    )
    return detachReadResult(
      await facetObjects(
        { query, facets, projectId: this.#runtime.projectId },
        this.#queryExecutorOptions()
      )
    )
  }

  get delegatedLimits(): DelegatedExecutionLimits | undefined {
    return this.#authority.type === "delegated" ? this.#authority.limits : undefined
  }

  #queryExecutorOptions() {
    return {
      ontology: this.#ontology,
      storage: this.#storage,
      executionLimits: this.delegatedLimits,
    }
  }

  #prepareAuthorizedQuery(
    authoredQuery: ExecuteObjectQueryInput["query"],
    projectedPropertyIds: readonly string[] = []
  ): ObjectQuery {
    const query = snapshotAuthoredQuery(authoredQuery)
    const validated = validateObjectQuery(query, { ontology: this.#ontology })
    const authorizationQuery =
      projectedPropertyIds.length === 0
        ? validated.query
        : {
            kind: "project" as const,
            input: validated.query,
            properties: [...projectedPropertyIds],
          }
    if (this.#authority.type === "delegated") {
      assertObjectQueryAuthorizedByAccessPlan(
        this.#authority.access,
        authorizationQuery,
        this.#ontology
      )
    } else if (this.#authority.type === "principal") {
      assertAuthorized(this.#runtime, {
        kind: "object.query",
        touchedObjectTypeIds: validated.touchedObjectTypeIds,
      })
    }
    return validated.query
  }

  #resolveListObjectTypes(
    requested: ListObjectsInput["objectTypeId"]
  ): ListObjectsInput["objectTypeId"] {
    if (requested !== undefined) {
      const objectTypeIds = typeof requested === "string" ? [requested] : requested
      for (const objectTypeId of objectTypeIds) {
        this.#ontology.resolveObjectType(objectTypeId)
        assertAuthorized(this.#runtime, { kind: "object.view", objectTypeId })
      }
      return requested
    }

    if (this.#authority.type === "unrestricted") return undefined
    return this.#ontology
      .listObjectTypes()
      .map((objectType) => objectType.id)
      .filter((objectTypeId) =>
        isRuntimeAllowed(this.#runtime, { kind: "object.view", objectTypeId })
      )
  }
}

export type AuthorizedObjectReader = AuthorizedObjectReaderImpl

/** Build the sole application-facing object reader for one registered execution scope. */
export function createAuthorizedObjectReader(input: {
  readonly scope: ExecutionScope
  readonly ontology: OntologyRegistry
  readonly objectStorage: ObjectStorage
}): AuthorizedObjectReader {
  const projectId = input.scope.execution.projectId
  const authority = resolveExecutionScopeAuthorization(projectId, input.scope)
  const storage =
    authority.type === "delegated"
      ? input.objectStorage.createReadScope({
          projectId,
          scope: objectReadScopeForAccessPlan(authority.access),
          limits: authority.limits,
        })
      : input.objectStorage

  return new AuthorizedObjectReaderImpl({
    scope: input.scope,
    ontology: input.ontology,
    storage,
    authority,
  })
}

/** Reject recombining an authorized reader with any other execution authority. */
export function assertAuthorizedObjectReaderBinding(input: {
  readonly reader: AuthorizedObjectReader
  readonly scope: ExecutionScope
}): void {
  input.reader.assertBound(input.scope)
}

/**
 * Storage providers are allowed to optimize trusted reads with live projection references.
 * Nothing crossing the application-facing authorization boundary may retain those references:
 * mutating a read result must never become an unaudited write to provider state.
 */
function detachReadResult<T>(value: T): T {
  return structuredClone(value)
}

function snapshotReadValue<T>(value: T): T {
  return structuredClone(value)
}

/**
 * Capture a serializable query once, then validate and execute only that snapshot. The initial
 * iterative guard keeps ordinary oversized trees away from structuredClone; the second guard
 * closes over getter-backed inputs whose structure changes while being captured.
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
