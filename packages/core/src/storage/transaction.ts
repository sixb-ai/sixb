import { StorageTransactionError } from "./errors"
import { createObjectOperationScope } from "./operation-scope"
import type { Storage } from "./types"

type ObjectLike = Record<PropertyKey, unknown>

export function createTransactionStorageProxy<T extends Storage>(
  target: T,
  isActive: () => boolean
): T {
  const proxies = new WeakMap<object, object>()
  const objectStorage = createObjectOperationScope(target.objects, {
    assertAvailable: () => assertTransactionActive(isActive),
    run: async <TResult>(operation: () => Promise<TResult> | TResult): Promise<TResult> => {
      assertTransactionActive(isActive)
      return operation()
    },
  })

  const wrap = <TValue extends object>(value: TValue): TValue => {
    const existing = proxies.get(value)
    if (existing) return existing as TValue

    const proxy = new Proxy(value as ObjectLike, {
      // The guard runs on property access and on call. Its purpose is to fail fast when a
      // transaction handle (`tx`) leaks past the transaction's lifetime — using it afterward is a
      // bug, not a recoverable state. Overhead is bounded: only the storage namespaces reachable
      // from `tx` are wrapped (a handful), not the row/link data graph, and never per-record.
      get(current, property, receiver) {
        assertTransactionActive(isActive)
        const result =
          current === target && property === "objects"
            ? objectStorage
            : Reflect.get(current, property, receiver)
        if (typeof result === "function") {
          return (...args: unknown[]) => {
            assertTransactionActive(isActive)
            return result.apply(current, args)
          }
        }
        if (result && typeof result === "object") {
          return wrap(result)
        }
        return result
      },
    })

    proxies.set(value, proxy)
    return proxy as TValue
  }

  return wrap(target)
}

export function assertTransactionActive(isActive: () => boolean): void {
  if (!isActive()) {
    throw new StorageTransactionError(
      "[Sixb] Transaction storage cannot be used after transaction completion.",
      { code: "transaction_inactive" }
    )
  }
}

export function throwNestedStorageTransaction(): never {
  throw new StorageTransactionError("[Sixb] Nested storage transactions are not supported yet.", {
    code: "nested_transaction",
  })
}
