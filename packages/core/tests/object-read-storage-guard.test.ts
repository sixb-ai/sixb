import { describe, expect, test } from "bun:test"
import type { ObjectReadStorage } from "../src/storage"
import { createGuardedObjectReadStorage } from "../src/storage/objects/guard"

describe("selected object reader guards", () => {
  test("forwards every terminal from a frozen provider reader through one guard", async () => {
    const provider = fullReader()
    let availabilityChecks = 0
    let guardedRuns = 0
    const reader = createGuardedObjectReadStorage(provider, {
      assertAvailable: () => {
        availabilityChecks += 1
      },
      run: async (operation) => {
        guardedRuns += 1
        return operation()
      },
    })

    expect(reader.queryCapabilities()).toEqual({ queryObjects: true })
    const query = { kind: "start", objectTypeId: "GuardedObject" } as const
    await reader.queryObjects?.({ projectId: "guard-project", query })
    await reader.countObjects?.({ projectId: "guard-project", query })
    await reader.existsObjects?.({ projectId: "guard-project", query })
    await reader.facetObjects?.({
      projectId: "guard-project",
      query,
      facets: [{ propertyId: "id", limit: 10 }],
    })
    await reader.getByPrimaryId({
      projectId: "guard-project",
      objectTypeId: "GuardedObject",
      primaryId: "root",
    })
    await reader.selectsObjectProperties({ projectId: "guard-project", items: [] })
    await reader.listLinks({
      projectId: "guard-project",
      objectTypeId: "GuardedObject",
      objectId: "root",
    })
    await reader.getByPrimaryIdBatch({ projectId: "guard-project", items: [] })
    await reader.listLinksBatch({ projectId: "guard-project", items: [] })
    await reader.queryLinks({
      projectId: "guard-project",
      objectRefs: [],
      direction: "outgoing",
      limit: 1,
    })
    await reader.list({ projectId: "guard-project" })

    expect(Object.isFrozen(provider)).toBe(true)
    expect(Object.isFrozen(reader)).toBe(true)
    expect(availabilityChecks).toBe(1)
    expect(guardedRuns).toBe(11)
  })

  test("does not invent optional query terminals", () => {
    const provider = requiredReader()
    const reader = createGuardedObjectReadStorage(provider, {
      assertAvailable: () => undefined,
      run: (operation) => operation(),
    })

    expect(reader.queryObjects).toBeUndefined()
    expect(reader.countObjects).toBeUndefined()
    expect(reader.existsObjects).toBeUndefined()
    expect(reader.facetObjects).toBeUndefined()
  })
})

function fullReader(): ObjectReadStorage {
  return Object.freeze({
    ...requiredReader(),
    queryCapabilities: () => ({ queryObjects: true }),
    queryObjects: async () => ({ objects: [], hasMore: false, total: 0 }),
    countObjects: async () => ({ count: 0 }),
    existsObjects: async () => ({ exists: false }),
    facetObjects: async () => ({ facets: [] }),
  })
}

function requiredReader(): ObjectReadStorage {
  return Object.freeze({
    queryCapabilities: () => ({ queryObjects: false }),
    getByPrimaryId: async () => null,
    selectsObjectProperties: async () => [],
    listLinks: async () => [],
    getByPrimaryIdBatch: async () => new Map(),
    listLinksBatch: async () => new Map(),
    queryLinks: async () => ({ links: [], hasMore: false }),
    list: async () => ({ objects: [], hasMore: false, total: 0 }),
  })
}
