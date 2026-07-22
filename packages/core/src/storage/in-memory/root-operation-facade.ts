/**
 * Root-operation façade machinery for {@link InMemoryStorage}.
 *
 * A "root operation" is a top-level storage call that must serialize against the transaction lock
 * when no transaction is already active. Lock-unaware stores (`objects`, `timeseries`, `auth`, …)
 * are wrapped here with a façade that acquires the lock around a fixed set of methods. See
 * `./index.ts` for how this relates to the alternative injected-runner model.
 */

type AsyncMethodKeys<T> = Extract<
  {
    [K in keyof T]-?: NonNullable<T[K]> extends (...args: infer _Args) => Promise<unknown>
      ? K
      : never
  }[keyof T],
  string
>

/**
 * Narrow a manifest of a store's async method names into the ordered list the façade factory
 * consumes. The `Record<AsyncMethodKeys<T>, true>` argument is exhaustive by construction, so the
 * type checker flags a manifest that drifts from the store's async surface.
 */
export function rootOperationMethods<T extends object>(
  methods: Readonly<Record<AsyncMethodKeys<T>, true>>
): readonly AsyncMethodKeys<T>[] {
  return Object.keys(methods) as AsyncMethodKeys<T>[]
}

export type RootOperationRunner = <TResult>(
  run: () => Promise<TResult> | TResult
) => Promise<TResult>

export function createRootOperationFacade<T extends object>(
  target: T,
  operationMethods: readonly PropertyKey[],
  runRootOperation: RootOperationRunner,
  propertyOverrides: Partial<T> = {}
): T {
  const operations = new Set<PropertyKey>(operationMethods)
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

  // Use a real object with own method descriptors instead of a Proxy. This preserves normal
  // assignment, decoration, and Bun spyOn semantics while built-in operations retain the root lock.
  for (const property of methodKeys) {
    const implementation = Reflect.get(target, property, target)
    if (typeof implementation !== "function") continue
    const value = operations.has(property)
      ? (...args: unknown[]) => runRootOperation(() => Reflect.apply(implementation, target, args))
      : implementation.bind(target)
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
