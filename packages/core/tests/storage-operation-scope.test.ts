import { describe, expect, test } from "bun:test"
import {
  compileSelectedObjectReadScope,
  type ObjectReadStorage,
  type ObjectStorage,
  StorageTransactionError,
} from "../src/storage"
import { InMemoryStorage } from "../src/storage/in-memory"
import {
  createObjectOperationScope,
  createOperationScopedFacade,
  createStorageOperationScope,
} from "../src/storage/operation-scope"

class TestStorage {
  async read(): Promise<string> {
    return "original"
  }
}

describe("storage operation scope", () => {
  test("fails closed when object storage omits the selected-read factory", () => {
    const malformed = { createSelectedReadScope: undefined } as unknown as ObjectStorage

    expect(() =>
      createObjectOperationScope(
        malformed,
        createStorageOperationScope(async (run) => run())
      )
    ).toThrow("must implement ObjectReadScopeFactory")
  })

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

  test("runs selected-reader terminals through the same root operation lock", async () => {
    const storage = new InMemoryStorage()
    const input = selectedReaderInput()
    const reader = storage.objects.createSelectedReadScope(input)
    let transactionEntered!: () => void
    const entered = new Promise<void>((resolve) => {
      transactionEntered = resolve
    })
    let releaseTransaction!: () => void
    const blocked = new Promise<void>((resolve) => {
      releaseTransaction = resolve
    })
    const transaction = storage.transaction(async () => {
      transactionEntered()
      await blocked
    })
    await entered

    let readFinished = false
    const read = reader.list({ projectId: input.projectId }).then((result) => {
      readFinished = true
      return result
    })
    try {
      await Bun.sleep(0)
      expect(readFinished).toBe(false)
    } finally {
      releaseTransaction()
      await transaction
    }
    await expect(read).resolves.toEqual({ objects: [], hasMore: false, total: 0 })
  })

  test("guards transaction-created readers and captured factory methods after completion", async () => {
    const storage = new InMemoryStorage()
    const input = selectedReaderInput()
    let escapedReader: ObjectReadStorage | undefined
    let escapedRead: ObjectReadStorage["list"] | undefined
    let escapedFactory: ObjectStorage["createSelectedReadScope"] | undefined

    await storage.transaction(async (tx) => {
      expect(() => storage.objects.createSelectedReadScope(input)).toThrow(
        "use the provided tx storage"
      )

      const reader = tx.objects.createSelectedReadScope(input)
      await expect(reader.list({ projectId: input.projectId })).resolves.toEqual({
        objects: [],
        hasMore: false,
        total: 0,
      })
      escapedReader = reader
      escapedRead = reader.list
      escapedFactory = tx.objects.createSelectedReadScope
    })

    if (!escapedReader || !escapedRead || !escapedFactory) {
      throw new Error("Expected transaction reader handles to be captured.")
    }
    const reader = escapedReader
    const read = escapedRead
    const createReader = escapedFactory
    expect(() => reader.queryCapabilities()).toThrow(StorageTransactionError)
    expect(() => createReader(input)).toThrow(StorageTransactionError)
    await expect(
      Promise.resolve().then(() => read({ projectId: input.projectId }))
    ).rejects.toMatchObject({ code: "transaction_inactive" })
  })
})

function selectedReaderInput() {
  const projectId = "operation-scope-project"
  return {
    projectId,
    scope: compileSelectedObjectReadScope({
      kind: "selected",
      roots: [
        {
          anchor: { objectTypeId: "OperationScopeObject", primaryId: "root" },
          node: {
            objects: [{ objectTypeId: "OperationScopeObject", propertyIds: ["id"] }],
            links: [],
          },
        },
      ],
    }),
    limits: { maxTraversalFacts: 10, maxOutputJsonBytes: 10_000 },
  }
}
