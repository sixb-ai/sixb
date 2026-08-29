import { StorageTransactionError } from "./errors"
import { createGuardedObjectReadStorage } from "./objects/guard"
import type { ObjectReadStorage } from "./objects/types"

type ObjectLike = Record<PropertyKey, unknown>

export function createTransactionStorageProxy<T extends object>(
  target: T,
  isActive: () => boolean
): T {
  const proxies = new WeakMap<object, object>()

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
        const result = Reflect.get(current, property, receiver)
        if (typeof result === "function") {
          return (...args: unknown[]) => {
            assertTransactionActive(isActive)
            const returned = result.apply(current, args)
            // ObjectStorage.createReadScope() is synchronous but returns another operation facade.
            // Keep that facade under the transaction lifetime guard instead of letting it escape.
            return isObjectReadStorageLike(returned)
              ? createGuardedObjectReadStorage(returned, {
                  assertAvailable: () => assertTransactionActive(isActive),
                  run: async (operation) => {
                    assertTransactionActive(isActive)
                    return operation()
                  },
                })
              : returned
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

function isObjectReadStorageLike(value: unknown): value is ObjectReadStorage {
  if (!value || typeof value !== "object") return false
  const candidate = value as ObjectLike
  return (
    typeof candidate.queryCapabilities === "function" &&
    typeof candidate.getByPrimaryId === "function" &&
    typeof candidate.list === "function"
  )
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
