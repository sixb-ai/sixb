import type { AgentStorage } from "./agents"
import type { AuthStorage } from "./auth"
import type { OntologyStorage } from "./ontology"
import type { WorkflowRunStorage } from "./workflow-runs"

export type StorageOperationRunner = <TResult>(
  run: () => Promise<TResult> | TResult
) => Promise<TResult>

/** Provider-owned execution boundary for root storage operations. */
export interface StorageOperationScope {
  assertAvailable(): void
  run<TResult>(operation: () => Promise<TResult> | TResult): Promise<TResult>
}

export function createStorageOperationScope(
  run: StorageOperationRunner,
  assertAvailable: () => void = () => undefined
): StorageOperationScope {
  return { assertAvailable, run }
}

/**
 * Give every async operation exposed by a store one provider-owned execution scope.
 *
 * Storage contracts use `async` methods for I/O and reserve synchronous methods for local
 * capabilities such as `queryCapabilities()`. Discovering the former from their implementation
 * removes the second, manually synchronized method registry that previously coupled every storage
 * primitive to the SQLite/InMemory lock.
 */
export function createOperationScopedFacade<T extends object>(
  target: T,
  scope: StorageOperationScope,
  propertyOverrides: Partial<T> = {}
): T {
  const facadeTarget = Object.create(Object.getPrototypeOf(target)) as T
  const methodKeys = new Set<PropertyKey>()
  for (
    let current: object | null = target;
    current && current !== Object.prototype;
    current = Object.getPrototypeOf(current)
  ) {
    for (const property of Reflect.ownKeys(current)) {
      if (property !== "constructor") methodKeys.add(property)
    }
  }

  for (const property of methodKeys) {
    const implementation = Reflect.get(target, property, target)
    if (typeof implementation !== "function") continue
    let value = implementation.bind(target)
    if (isAsyncFunction(implementation)) {
      value = (...args: unknown[]) => scope.run(() => Reflect.apply(implementation, target, args))
    } else if (isAsyncGeneratorFunction(implementation)) {
      value = (...args: unknown[]) => {
        scope.assertAvailable()
        return Reflect.apply(implementation, target, args)
      }
    }
    Reflect.defineProperty(facadeTarget, property, {
      configurable: true,
      enumerable: false,
      writable: true,
      value,
    })
  }

  for (const property of Reflect.ownKeys(propertyOverrides)) {
    Reflect.defineProperty(facadeTarget, property, {
      configurable: true,
      enumerable: true,
      writable: false,
      value: Reflect.get(propertyOverrides, property, propertyOverrides),
    })
  }

  return facadeTarget
}

export function createAuthOperationScope<T extends AuthStorage>(
  target: T,
  scope: StorageOperationScope
): T {
  return createOperationScopedFacade<AuthStorage>(target, scope, {
    users: createOperationScopedFacade(target.users, scope),
    identities: createOperationScopedFacade(target.identities, scope),
    serviceAccounts: createOperationScopedFacade(target.serviceAccounts, scope),
    serviceAccountGroupMemberships: createOperationScopedFacade(
      target.serviceAccountGroupMemberships,
      scope
    ),
    sessions: createOperationScopedFacade(target.sessions, scope),
    accessTokens: createOperationScopedFacade(target.accessTokens, scope),
    invitations: createOperationScopedFacade(target.invitations, scope),
    groupMemberships: createOperationScopedFacade(target.groupMemberships, scope),
    magicLinks: createOperationScopedFacade(target.magicLinks, scope),
    oidcAuthorizationAttempts: createOperationScopedFacade(target.oidcAuthorizationAttempts, scope),
  }) as T
}

export function createAgentOperationScope<T extends AgentStorage>(
  target: T,
  scope: StorageOperationScope
): T {
  return createOperationScopedFacade<AgentStorage>(target, scope, {
    threads: createOperationScopedFacade(target.threads, scope),
    runs: createOperationScopedFacade(target.runs, scope),
    messages: createOperationScopedFacade(target.messages, scope),
  }) as T
}

export function createOntologyOperationScope<T extends OntologyStorage>(
  target: T,
  scope: StorageOperationScope
): T {
  return createOperationScopedFacade<OntologyStorage>(target, scope, {
    commits: createOperationScopedFacade(target.commits, scope),
    sources: createOperationScopedFacade(target.sources, scope),
    materializations: createOperationScopedFacade(target.materializations, scope),
    outbox: createOperationScopedFacade(target.outbox, scope),
  }) as T
}

export function createWorkflowRunOperationScope<T extends WorkflowRunStorage>(
  target: T,
  scope: StorageOperationScope
): T {
  return createOperationScopedFacade<WorkflowRunStorage>(target, scope, {
    nodes: createOperationScopedFacade(target.nodes, scope),
  }) as T
}

function isAsyncFunction(value: unknown): value is (...args: unknown[]) => Promise<unknown> {
  return typeof value === "function" && value.constructor.name === "AsyncFunction"
}

function isAsyncGeneratorFunction(value: unknown): boolean {
  return typeof value === "function" && value.constructor.name === "AsyncGeneratorFunction"
}
