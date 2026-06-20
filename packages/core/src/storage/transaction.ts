import { StorageTransactionError } from "./errors"

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
    throw new StorageTransactionError(
      "[Sixb] Transaction storage cannot be used after transaction completion."
    )
  }
}

export function throwNestedStorageTransaction(): never {
  throw new StorageTransactionError("[Sixb] Nested storage transactions are not supported yet.")
}
