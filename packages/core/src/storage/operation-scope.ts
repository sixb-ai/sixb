import { AsyncLocalStorage } from "node:async_hooks"
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
  const executions = new AsyncLocalStorage<{ active: boolean }>()
  return {
    assertAvailable,
    async run(operation) {
      const inherited = executions.getStore()
      if (inherited?.active) {
        assertAvailable()
        return operation()
      }

      const execution = { active: true }
      try {
        return await executions.run(execution, () => run(operation))
      } finally {
        execution.active = false
      }
    },
  }
}

const operationScopeTargets = new WeakMap<object, object>()

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
  const methodKinds = discoverMethodKinds(target)
  const overrideKeys = new Set(Reflect.ownKeys(propertyOverrides))
  const methodCache = new Map<
    PropertyKey,
    { implementation: (...args: unknown[]) => unknown; exposed: (...args: unknown[]) => unknown }
  >()

  const facade = new Proxy(target, {
    get(current, property) {
      if (overrideKeys.has(property)) {
        return Reflect.get(propertyOverrides, property, propertyOverrides)
      }

      const value = Reflect.get(current, property, current)
      const kind = methodKinds.get(property)
      if (!kind || typeof value !== "function") return value
      const implementation = value as (...args: unknown[]) => unknown

      const cached = methodCache.get(property)
      if (cached?.implementation === implementation) return cached.exposed

      const exposed = scopeMethod(implementation, kind, current, scope)
      methodCache.set(property, { implementation, exposed })
      return exposed
    },
    set(current, property, value) {
      if (overrideKeys.has(property)) return false
      return Reflect.set(current, property, value, current)
    },
    defineProperty(current, property, attributes) {
      if (overrideKeys.has(property)) return false
      return Reflect.defineProperty(current, property, attributes)
    },
    deleteProperty(current, property) {
      if (overrideKeys.has(property)) return false
      return Reflect.deleteProperty(current, property)
    },
  })
  operationScopeTargets.set(facade, target)
  return facade
}

type StorageMethod = (...args: never[]) => unknown
type StorageMethodKey<T> = {
  [TKey in keyof T]-?: T[TKey] extends StorageMethod ? TKey : never
}[keyof T]

/** Replace a provider method behind its scoped facade without exposing the raw provider. */
export function decorateOperationScopedMethodForTesting<
  T extends object,
  TKey extends StorageMethodKey<T>,
>(
  facade: T,
  property: TKey,
  decorate: (implementation: Extract<T[TKey], StorageMethod>) => Extract<T[TKey], StorageMethod>
): () => void {
  const target = operationScopeTargets.get(facade)
  if (!target) throw new Error("[Sixb] Expected an operation-scoped storage facade.")

  const previousDescriptor = Reflect.getOwnPropertyDescriptor(target, property)
  const implementation = Reflect.get(target, property, target)
  if (typeof implementation !== "function") {
    throw new Error(`[Sixb] Storage property '${String(property)}' is not a method.`)
  }

  const boundImplementation = ((...args: never[]) =>
    Reflect.apply(implementation, target, args)) as Extract<T[TKey], StorageMethod>
  const decorated = decorate(boundImplementation)
  Reflect.defineProperty(target, property, {
    configurable: true,
    enumerable: previousDescriptor?.enumerable ?? false,
    writable: true,
    value: decorated,
  })

  return () => {
    if (previousDescriptor) {
      Reflect.defineProperty(target, property, previousDescriptor)
    } else {
      Reflect.deleteProperty(target, property)
    }
  }
}

type StorageMethodKind = "async" | "async-generator" | "sync"

function discoverMethodKinds(target: object): ReadonlyMap<PropertyKey, StorageMethodKind> {
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

  const methodKinds = new Map<PropertyKey, StorageMethodKind>()
  for (const property of methodKeys) {
    const implementation = Reflect.get(target, property, target)
    if (typeof implementation !== "function") continue
    methodKinds.set(property, methodKind(implementation))
  }
  return methodKinds
}

function methodKind(implementation: (...args: unknown[]) => unknown): StorageMethodKind {
  if (isAsyncFunction(implementation)) return "async"
  if (isAsyncGeneratorFunction(implementation)) return "async-generator"
  return "sync"
}

function scopeMethod(
  implementation: (...args: unknown[]) => unknown,
  kind: StorageMethodKind,
  target: object,
  scope: StorageOperationScope
): (...args: unknown[]) => unknown {
  if (kind === "async") {
    return (...args: unknown[]) => scope.run(() => Reflect.apply(implementation, target, args))
  }

  if (kind === "async-generator") {
    return (...args: unknown[]) => {
      scope.assertAvailable()
      return Reflect.apply(implementation, target, args)
    }
  }

  return implementation.bind(target)
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
    agentNodes: createOperationScopedFacade(target.agentNodes, scope),
  }) as T
}

function isAsyncFunction(value: unknown): value is (...args: unknown[]) => Promise<unknown> {
  return typeof value === "function" && value.constructor.name === "AsyncFunction"
}

function isAsyncGeneratorFunction(value: unknown): boolean {
  return typeof value === "function" && value.constructor.name === "AsyncGeneratorFunction"
}
