import { describe, expect, test } from "bun:test"
import {
  createOperationScopedFacade,
  createStorageOperationScope,
} from "../src/storage/operation-scope"

class TestStorage {
  async read(): Promise<string> {
    return "original"
  }
}

describe("storage operation scope", () => {
  test("keeps decorated provider methods inside their operation scope", async () => {
    const target = new TestStorage()
    let scopeRuns = 0
    const facade = createOperationScopedFacade(
      target,
      createStorageOperationScope(async (operation) => {
        scopeRuns += 1
        return operation()
      })
    )
    const originalRead = facade.read.bind(facade)

    Object.defineProperty(facade, "read", {
      configurable: true,
      value: async () => `decorated:${await originalRead()}`,
      writable: true,
    })

    await expect(facade.read()).resolves.toBe("decorated:original")
    expect(scopeRuns).toBe(1)
    await expect(target.read()).resolves.toBe("decorated:original")
  })

  test("does not let a decorated method bypass an unavailable scope", async () => {
    const target = new TestStorage()
    let called = false
    const facade = createOperationScopedFacade(
      target,
      createStorageOperationScope(async () => {
        throw new Error("scope unavailable")
      })
    )

    Object.defineProperty(facade, "read", {
      configurable: true,
      value: () => {
        called = true
        return Promise.resolve("decorated")
      },
      writable: true,
    })

    await expect(facade.read()).rejects.toThrow("scope unavailable")
    expect(called).toBe(false)
  })

  test("rechecks availability before a reentrant decorated call", async () => {
    const target = new TestStorage()
    let available = true
    const facade = createOperationScopedFacade(
      target,
      createStorageOperationScope(
        async (operation) => operation(),
        () => {
          if (!available) throw new Error("scope became unavailable")
        }
      )
    )
    const originalRead = facade.read.bind(facade)

    Object.defineProperty(facade, "read", {
      configurable: true,
      value: async () => {
        available = false
        return originalRead()
      },
      writable: true,
    })

    await expect(facade.read()).rejects.toThrow("scope became unavailable")
  })
})
