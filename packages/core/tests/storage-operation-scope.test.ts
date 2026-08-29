import { describe, expect, test } from "bun:test"
import type { ObjectReadStorage } from "../src/storage"
import { InMemoryStorage } from "../src/storage/in-memory"
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

  test("keeps created object readers inside the root lock and transaction lifetime", async () => {
    const storage = new InMemoryStorage()
    const readerInput = {
      projectId: "operation-scope-project",
      scope: { kind: "all" as const },
      limits: {
        maxTraversalFacts: 10,
        maxVisibleJsonBytes: 1_000,
      },
    }
    const rootReader = storage.objects.createReadScope(readerInput)
    let escapedReader: ObjectReadStorage | undefined

    await storage.transaction(async (tx) => {
      await expect(rootReader.list({ projectId: readerInput.projectId })).rejects.toMatchObject({
        name: "StorageTransactionError",
      })

      const transactionReader = tx.objects.createReadScope(readerInput)
      await expect(transactionReader.list({ projectId: readerInput.projectId })).resolves.toEqual({
        objects: [],
        hasMore: false,
        total: 0,
      })
      escapedReader = transactionReader
    })

    await expect(
      Promise.resolve().then(() => escapedReader?.list({ projectId: readerInput.projectId }))
    ).rejects.toMatchObject({
      name: "StorageTransactionError",
      code: "transaction_inactive",
    })
  })
})
