import { describe, expect, test } from "bun:test"
import {
  compileSelectedObjectReadScope,
  type ObjectReadStorage,
  type ObjectStorage,
  StorageTransactionError,
} from "../src/storage"
import { InMemoryAuthStorage } from "../src/storage/auth"
import { InMemoryStorage } from "../src/storage/in-memory"
import {
  createAuthOperationScope,
  createObjectOperationScope,
  createOperationScopedFacade,
  createStorageOperationScope,
} from "../src/storage/operation-scope"

class TestStorage {
  async read(): Promise<string> {
    return "original"
  }
}

class TestStream {
  constructor(private readonly observe: (step: string) => void) {}

  async *pages(): AsyncGenerator<number> {
    this.observe("first")
    yield 1
    this.observe("second")
    yield 2
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

  // An unwrapped store skips the provider's lock: on SQLite its writes can land inside another
  // request's open transaction. Reproduce: drop `deviceAuthorizations` from createAuthOperationScope.
  test("scopes every auth store", () => {
    const target = new InMemoryAuthStorage()
    const scoped = createAuthOperationScope(
      target,
      createStorageOperationScope(async (run) => run())
    )
    // Stores are class instances; the shared state behind them is a plain object.
    const stores = Object.entries(target).filter(
      ([, value]) =>
        typeof value === "object" &&
        value !== null &&
        Object.getPrototypeOf(value) !== Object.prototype
    )

    expect(stores.map(([name]) => name)).toContain("deviceAuthorizations")
    for (const [name, store] of stores) {
      expect(Reflect.get(scoped, name), name).not.toBe(store)
    }
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

  // A stream page read outside the provider's lock lands inside another request's open
  // transaction on SQLite. Reproduce: return the generator unwrapped from scopeMethod.
  test("runs each step of a stream in its own operation scope", async () => {
    let held = false
    const steps: string[] = []
    const facade = createOperationScopedFacade(
      new TestStream((step) => steps.push(`${step}:${held}`)),
      createStorageOperationScope(async (operation) => {
        held = true
        try {
          return await operation()
        } finally {
          held = false
        }
      })
    )

    const seen: string[] = []
    for await (const page of facade.pages()) seen.push(`${page}:${held}`)

    expect(steps).toEqual(["first:true", "second:true"])
    expect(seen).toEqual(["1:false", "2:false"])
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
