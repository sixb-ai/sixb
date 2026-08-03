import { storageTransactionError } from "../storage/errors"

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
    throw storageTransactionError(
      "[Sixb] Transaction storage cannot be used after transaction completion.",
      { reason: "transaction_inactive" }
    )
  }
}

export function throwNestedStorageTransaction(): never {
  throw storageTransactionError("[Sixb] Nested storage transactions are not supported yet.", {
    reason: "nested_transaction",
  })
}
