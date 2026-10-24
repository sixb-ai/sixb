import { afterEach, describe, expect, jest, test } from "bun:test"
import { defineObjectType, InMemoryStorage, OntologyRegistry, prop, type Storage } from "../src"
import { StorageTransactionError } from "../src/storage/errors"
import { prepareUniqueProperties } from "../src/storage/migrations/prepare-unique-properties"

const projectId = "prepare-unique"

const Person = defineObjectType({
  id: "Person",
  name: "Person",
  properties: [
    prop("id", "string", { primary: true, required: true }),
    prop("email", "string", { unique: true }),
  ],
})
const ontology = new OntologyRegistry({ sources: [Person] })

afterEach(() => {
  jest.useRealTimers()
})

/** InMemory storage whose first `failures` transactions fail serialization. */
function failingStorage(failures: number) {
  const storage = new InMemoryStorage()
  const failure = new StorageTransactionError("[Sixb] Serialization failure.", {
    code: "serialization_failure",
  })
  let calls = 0

  const failing = new Proxy(storage, {
    get(target, property) {
      if (property !== "transaction") {
        const value = Reflect.get(target, property, target)
        return typeof value === "function" ? value.bind(target) : value
      }
      return ((run, options) => {
        calls += 1
        if (calls <= failures) return Promise.reject(failure)
        return target.transaction(run, options)
      }) satisfies Storage["transaction"]
    },
  })
  return { storage, failing, failure, calls: () => calls }
}

function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

describe("prepareUniqueProperties", () => {
  // Removal proof: set `MAX_PREPARATION_ATTEMPTS` to 1 in `prepare-unique-properties.ts`, or
  // rethrow every error from `withRetries`; the preparation then fails with the first failure.
  test("starts a property over after a serialization failure, once its backoff passed", async () => {
    jest.useFakeTimers()
    const { storage, failing, calls } = failingStorage(1)

    const preparing = prepareUniqueProperties({ storage: failing, projectId, ontology })
    await flush()
    expect(calls()).toBe(1)

    jest.advanceTimersByTime(49)
    await flush()
    expect(calls()).toBe(1)

    jest.advanceTimersByTime(1)
    await preparing

    expect(calls()).toBe(2)
    expect(await storage.ontology.uniqueValues.listPrepared({ projectId })).toMatchObject([
      { objectTypeId: "Person", propertyId: "email" },
    ])
  })

  // Removal proof: raise `MAX_PREPARATION_ATTEMPTS` to 6; the preparation then tries a sixth time.
  test("gives up with the original failure after its last attempt", async () => {
    jest.useFakeTimers()
    const { failing, failure, calls } = failingStorage(Number.POSITIVE_INFINITY)

    let settled = false
    const preparing = prepareUniqueProperties({ storage: failing, projectId, ontology })
      .catch((error: unknown) => error)
      .finally(() => {
        settled = true
      })
    for (let turn = 0; turn < 10 && !settled; turn++) {
      await flush()
      jest.runOnlyPendingTimers()
    }

    expect(await preparing).toBe(failure)
    expect(calls()).toBe(5)
  })
})
