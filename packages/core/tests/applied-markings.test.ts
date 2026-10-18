import { afterAll, afterEach, describe, expect, jest, spyOn, test } from "bun:test"
import type { DatasetVersion } from "../src/lake-storage"
import {
  APPLIED_MARKINGS_FRESH_MS,
  APPLIED_MARKINGS_MAX_AGE_MS,
  createAppliedMarkings,
} from "../src/security/applied-markings"
import {
  type AppliedMarkingsSnapshot,
  NO_APPLIED_MARKINGS,
} from "../src/security/applied-markings-snapshot"
import { getDatasetVersionMarkings } from "../src/security/internal"
import { createAppliedProject, type InvoiceProjection, projectId } from "./applied-markings-fixture"

// A fake-timer test that times out never reaches its own cleanup; keep it from leaking.
afterEach(() => {
  jest.useRealTimers()
})

// What the dataset versions projections applied add to the ontology's markings, and how the host
// keeps that snapshot current: read when reads need it, with one storage query, and reclassified
// only where an applied version changed.

const warn = spyOn(console, "warn").mockImplementation(() => {})
afterEach(() => warn.mockClear())
afterAll(() => warn.mockRestore())

/** A refresh over these in-memory sources is a chain of promise callbacks: one macrotask drains it. */
const drain = () => new Promise<void>((resolve) => setImmediate(resolve))

/** The host's resolver, its lake, and its sources, behind a hand-driven clock. */
async function setup(
  options: {
    readonly variant?: InvoiceProjection
    readonly marked?: boolean
    readonly maxAgeMs?: number
  } = {}
) {
  const project = await createAppliedProject(options)
  const versionMarkings = getDatasetVersionMarkings(project.host)

  const calls = { listActive: 0, getVersion: 0, classify: 0 }
  const clock = { now: 0 }

  let failure: Error | undefined
  let lakeFailure: Error | undefined
  let storageGate: Promise<void> | undefined
  let lakeGate: Promise<void> | undefined
  let lakeReached: (() => void) | undefined

  const applied = createAppliedMarkings({
    projectId,
    ontology: project.host.definitions.ontology,
    projections: project.host.definitions.projections,
    revisionOf: project.revisionOf,
    pipelines: project.host.definitions.pipelines.list(),
    versionMarkings: {
      ...versionMarkings,
      classify: (version) => {
        calls.classify += 1
        return versionMarkings.classify(version)
      },
    },
    lakeStorage: {
      getVersion: async (datasetId, versionId) => {
        calls.getVersion += 1
        lakeReached?.()
        await lakeGate
        if (lakeFailure) throw lakeFailure
        return project.lake.getVersion(datasetId, versionId)
      },
    },
    sources: {
      listActive: async () => {
        calls.listActive += 1
        const active = [...project.active]
        await storageGate
        if (failure) throw failure
        return active
      },
    },
    now: () => clock.now,
    ...(options.maxAgeMs === undefined ? {} : { maxAgeMs: options.maxAgeMs }),
  })

  return {
    ...project,
    applied,
    calls,
    clock,
    /** A read past the bound, which waits for a refresh. */
    async refresh() {
      clock.now += APPLIED_MARKINGS_MAX_AGE_MS + 1
      return applied.current()
    },
    failStorage(error?: Error) {
      failure = error
    },
    failLake(error?: Error) {
      lakeFailure = error
    },
    /** Hold the next storage reads until the returned function is called. */
    holdStorage(): () => void {
      let release = () => {}
      storageGate = new Promise((resolve) => {
        release = resolve
      })
      return () => {
        storageGate = undefined
        release()
      }
    },
    /** Hold the next lake reads; `reached` settles once a read is waiting on the hold. */
    holdLake(): { readonly reached: Promise<void>; release(): void } {
      const reached = Promise.withResolvers<void>()
      const gate = Promise.withResolvers<void>()
      lakeReached = reached.resolve
      lakeGate = gate.promise
      return {
        reached: reached.promise,
        release() {
          lakeGate = undefined
          lakeReached = undefined
          gate.resolve()
        },
      }
    },
  }
}

/** A snapshot as plain data, for assertions. */
function plain(snapshot: AppliedMarkingsSnapshot) {
  return {
    properties: Object.fromEntries(
      [...snapshot.properties].map(([type, byProperty]) => [
        type,
        Object.fromEntries([...byProperty].map(([id, set]) => [id, [...set]])),
      ])
    ),
    types: Object.fromEntries(
      [...snapshot.types].map(([type, seals]) => [
        type,
        seals.map((seal) => ({ ...seal, markings: [...seal.markings] })),
      ])
    ),
    links: Object.fromEntries(
      [...snapshot.links.values()].map((link) => [
        `${link.objectTypeId}.${link.linkId}`,
        link.seals.map((seal) => ({ ...seal, markings: [...seal.markings] })),
      ])
    ),
    markings: [...snapshot.markings],
  }
}

/** Day 1: the title was computed from the amount. */
const titleFromAmount = { title: ["amount"] }

describe("applied markings", () => {
  test("a project without marked columns reads nothing", async () => {
    const app = await setup({ marked: false })
    app.apply(await app.normalized(titleFromAmount))

    expect(app.applied.affects(new Set())).toBe(false)
    expect(await app.applied.current()).toBe(NO_APPLIED_MARKINGS)
    expect(app.calls).toMatchObject({ listActive: 0 })
  })

  test("a compliant applied version adds nothing and is classified once", async () => {
    const app = await setup()
    app.apply(await app.normalized())

    expect(app.applied.affects(new Set())).toBe(true)
    expect(app.applied.affects(new Set(["financial"]))).toBe(false)
    expect(await app.applied.current()).toBe(NO_APPLIED_MARKINGS)
    expect(app.calls).toMatchObject({ listActive: 1, classify: 1 })

    // Reproduce: drop the `previous.key === key` reuse in createAppliedMarkings' read; every
    // refresh classifies the version again.
    for (let index = 0; index < 3; index += 1) await app.refresh()
    expect(app.calls).toMatchObject({ listActive: 4, classify: 1 })
  })

  // Reproduce: in appliedContribution, return NO_CONTRIBUTION before computing projectionSurplus;
  // the title loses its marking.
  test("a property keeps the markings its applied version carries until a compliant one", async () => {
    const app = await setup()
    const dayOne = await app.normalized(titleFromAmount)
    app.apply(dayOne)

    const snapshot = await app.applied.current()
    expect(plain(snapshot)).toEqual({
      properties: { Invoice: { title: ["financial"] } },
      types: {},
      links: {},
      markings: ["financial"],
    })
    expect(snapshot.notices).toEqual([
      {
        projectionId: "invoices",
        sealed: false,
        message: `[Sixb] Projection 'invoices' applied version '${dayOne.versionId}' of 'invoices_normalized', in which property 'Invoice.title' is projected from column 'invoices_normalized.title', which carries [financial]. 'Invoice.title' keeps these markings until the projection applies a version the code allows. Rerun pipeline 'finance' to replace it.`,
      },
    ])
    // Only a projection that seals something warns.
    expect(warn).not.toHaveBeenCalled()

    app.apply(await app.normalized())
    expect(await app.refresh()).toBe(NO_APPLIED_MARKINGS)
  })

  test("a version without lineage seals its object type, once warned", async () => {
    const app = await setup()
    const legacy = await app.normalized(null)
    app.apply(legacy)

    const snapshot = await app.applied.current()
    const reason = `in the version '${legacy.versionId}' it applied, column 'invoices_normalized.id', which becomes the id of 'Invoice',`
    expect(plain(snapshot)).toEqual({
      properties: {
        Invoice: { customerId: ["financial"], title: ["financial"] },
      },
      types: { Invoice: [{ projectionId: "invoices", markings: ["financial"], reason }] },
      links: {},
      markings: ["financial"],
    })
    const message = `[Sixb] Projection 'invoices' applied version '${legacy.versionId}' of 'invoices_normalized', in which column 'invoices_normalized.id' becomes the id of 'Invoice' and carries [financial]; property 'Invoice.customerId' is projected from column 'invoices_normalized.customer_id', which carries [financial]; property 'Invoice.title' is projected from column 'invoices_normalized.title', which carries [financial]. The version was classified with every marking its sources could hold, because version '${legacy.versionId}' of 'invoices_normalized' recorded no column lineage. 'Invoice' cannot be read without clearance for [financial], and 'Invoice.customerId' and 'Invoice.title' keep these markings until the projection applies a version the code allows. Rerun pipeline 'finance' to replace it.`
    expect(snapshot.notices).toEqual([{ projectionId: "invoices", sealed: true, message }])

    app.applied.invalidate()
    await app.applied.current()
    await app.refresh()
    expect(warn.mock.calls).toEqual([[message]])
  })

  test("an applied version the lake no longer has seals the type until it is read again", async () => {
    const app = await setup()
    const missing = { ...(await app.normalized()), versionId: "gone" } satisfies DatasetVersion
    app.apply(missing)

    const snapshot = await app.applied.current()
    expect(plain(snapshot).types).toEqual({
      Invoice: [
        {
          projectionId: "invoices",
          markings: ["financial"],
          reason:
            "the version 'gone' of 'invoices_normalized' it applied, which the lake no longer has,",
        },
      ],
    })
    expect(warn.mock.calls).toEqual([
      [
        "[Sixb] Projection 'invoices' applied version 'gone' of 'invoices_normalized', which the lake no longer has. 'Invoice' cannot be read without clearance for [financial] until the projection applies a version the code allows. Rerun pipeline 'finance' to replace it.",
      ],
    ])

    const reads = app.calls.getVersion
    await app.refresh()
    expect(app.calls.getVersion).toBe(reads + 1)
  })

  test("a lake failure seals the type and is read again on the next refresh", async () => {
    const app = await setup()
    app.apply(await app.normalized())
    app.failLake(new Error("lake offline"))

    expect(plain(await app.applied.current()).types).toEqual({
      Invoice: [
        {
          projectionId: "invoices",
          markings: ["financial"],
          reason:
            "the version '" +
            app.active[0]!.datasetVersion.versionId +
            "' of 'invoices_normalized' it applied, which could not be read from the lake,",
        },
      ],
    })
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0]?.[0])).toContain(
      "which could not be read from the lake: lake offline."
    )

    app.failLake()
    expect(await app.refresh()).toBe(NO_APPLIED_MARKINGS)
  })

  // Reproduce: drop the projectionRevision comparison in appliedContribution; the type stays
  // readable.
  test("objects written by an earlier definition seal their type with every marking of the version", async () => {
    const app = await setup()
    const version = await app.normalized()
    app.apply(version, "an-earlier-revision")

    expect(plain(await app.applied.current()).types).toEqual({
      Invoice: [
        {
          projectionId: "invoices",
          markings: ["financial"],
          reason: `the version '${version.versionId}' of 'invoices_normalized' it applied under an earlier definition of the projection`,
        },
      ],
    })
  })

  test("a marked link key seals the link", async () => {
    const app = await setup({ variant: "linkField" })
    const version = await app.normalized({ customer_id: ["amount"] })
    app.apply(version)

    const snapshot = await app.applied.current()
    expect(plain(snapshot)).toMatchObject({
      properties: { Invoice: { customerId: ["financial"] } },
      types: {},
      links: {
        "Invoice.customer": [
          {
            projectionId: "invoices",
            markings: ["financial"],
            reason: `in the version '${version.versionId}' it applied, column 'invoices_normalized.customer_id', which keys link 'Invoice.customer',`,
          },
        ],
      },
    })
    expect([...snapshot.links.values()][0]?.targetObjectTypeId).toBe("Customer")
  })

  test("a property that keys a link keeps its markings, and seals the link", async () => {
    const app = await setup({ variant: "linkProperty" })
    app.apply(await app.normalized({ customer_id: ["amount"] }))

    expect(plain(await app.applied.current())).toMatchObject({
      properties: { Invoice: { customerId: ["financial"] } },
      types: {},
      links: { "Invoice.customer": [{ markings: ["financial"] }] },
    })
  })

  test("a marked mostRecent timestamp seals the type", async () => {
    const app = await setup({ variant: "mostRecent" })
    app.apply(await app.normalized({ updated_at: ["amount"] }))

    expect(plain(await app.applied.current()).types).toMatchObject({
      Invoice: [
        {
          reason: expect.stringContaining(
            "column 'invoices_normalized.updated_at', which decides which value wins under 'mostRecent',"
          ),
        },
      ],
    })
  })

  // Reproduce: drop the fingerprint comparison in publish; each refresh returns a new object.
  test("equal content keeps the snapshot object, so resolved clearances stay cached", async () => {
    const app = await setup()
    app.apply(await app.normalized(titleFromAmount))
    const first = await app.applied.current()

    expect(await app.refresh()).toBe(first)

    // A version the lake cannot read is read again on every refresh, to the same result.
    app.failLake(new Error("lake offline"))
    app.apply(await app.normalized())
    const sealed = await app.refresh()
    expect(sealed).not.toBe(first)

    const reads = app.calls.getVersion
    expect(await app.refresh()).toBe(sealed)
    expect(app.calls.getVersion).toBe(reads + 1)
  })

  // Reproduce: make invalidate a no-op; the read returns the Day 1 snapshot.
  test("a projection applied in this process is read by the next read", async () => {
    const app = await setup()
    app.apply(await app.normalized(titleFromAmount))
    const before = await app.applied.current()
    expect(before.markings.size).toBe(1)

    app.apply(await app.normalized())
    expect(await app.applied.current()).toBe(before)
    app.applied.invalidate()
    expect(await app.applied.current()).toBe(NO_APPLIED_MARKINGS)
  })

  // Reproduce: return the snapshot whatever its age in current(); every read below resolves
  // without listing the sources. Await refreshBehind there; the reads past five seconds wait.
  test("a read uses a fresh snapshot, refreshes behind a recent one, and waits for an old one", async () => {
    const app = await setup()
    app.apply(await app.normalized(titleFromAmount))
    const dayOne = await app.applied.current()
    app.apply(await app.normalized())

    app.clock.now = APPLIED_MARKINGS_FRESH_MS - 1
    expect(await app.applied.current()).toBe(dayOne)
    expect(app.calls.listActive).toBe(1)

    // Recent: the read answers at once, and one refresh runs behind it.
    const release = app.holdStorage()
    app.clock.now = APPLIED_MARKINGS_FRESH_MS
    expect(await app.applied.current()).toBe(dayOne)
    expect(await app.applied.current()).toBe(dayOne)
    expect(app.calls.listActive).toBe(2)

    release()
    await drain()
    expect(await app.applied.current()).toBe(NO_APPLIED_MARKINGS)
    expect(app.calls.listActive).toBe(2)

    // Old: the read waits for the refresh.
    app.apply(await app.normalized(titleFromAmount))
    app.clock.now += APPLIED_MARKINGS_MAX_AGE_MS + 1
    expect((await app.applied.current()).markings).toEqual(new Set(["financial"]))
    expect(app.calls.listActive).toBe(3)
  })

  // Reproduce: drop the age condition from the catch in current(); the late read resolves.
  test("a failed refresh keeps the snapshot until the bound, then reads fail closed", async () => {
    const app = await setup()
    app.apply(await app.normalized(titleFromAmount))
    const snapshot = await app.applied.current()

    app.failStorage(new Error("storage offline"))
    app.clock.now = APPLIED_MARKINGS_FRESH_MS
    expect(await app.applied.current()).toBe(snapshot)
    await drain()
    expect(await app.applied.current()).toBe(snapshot)
    await drain()
    expect(warn.mock.calls).toEqual([
      [
        "[Sixb] Could not read the dataset versions projections applied: storage offline. Reads keep the markings read before for up to 10s, then fail until it succeeds.",
      ],
    ])

    app.clock.now = APPLIED_MARKINGS_MAX_AGE_MS
    expect(await app.applied.current()).toBe(snapshot)
    await drain()

    app.clock.now = APPLIED_MARKINGS_MAX_AGE_MS + 1
    await expect(app.applied.current()).rejects.toThrow(
      "[Sixb] Cannot read the dataset versions projections applied, so markings cannot be enforced: storage offline"
    )

    app.failStorage()
    expect(await app.applied.current()).toBe(snapshot)

    // A new streak of failures warns again.
    app.failStorage(new Error("storage offline"))
    app.clock.now += APPLIED_MARKINGS_FRESH_MS
    await app.applied.current()
    await drain()
    expect(warn).toHaveBeenCalledTimes(2)
  })

  test("a first read that cannot read the applied versions fails", async () => {
    const app = await setup()
    app.failStorage(new Error("storage offline"))
    await expect(app.applied.current()).rejects.toThrow("storage offline")
  })

  // Reproduce: bump the generation in invalidate only once a snapshot exists; the first read's
  // snapshot is returned, with the Day 1 title.
  test("a projection applied while the first snapshot is read is read by the next read", async () => {
    const app = await setup()
    app.apply(await app.normalized(titleFromAmount))
    const lake = app.holdLake()
    const first = app.applied.current()
    // The first read has listed the Day 1 sources and waits on the lake.
    await lake.reached

    app.apply(await app.normalized())
    app.applied.invalidate()
    lake.release()
    await first
    expect(await app.applied.current()).toBe(NO_APPLIED_MARKINGS)
  })

  // Reproduce: drop the deadline from refresh in createAppliedMarkings; the read never settles.
  test("a refresh that hangs fails reads at its deadline, and a late answer is discarded", async () => {
    const app = await setup({ maxAgeMs: 40 })
    app.apply(await app.normalized(titleFromAmount))
    const release = app.holdStorage()

    // The deadline is a timer: fake time reaches it without waiting.
    jest.useFakeTimers()
    let read: string
    try {
      const reading = app.applied.current().then(
        () => "resolved",
        (error: Error) => error.message
      )
      jest.advanceTimersByTime(40)
      // Bounded here too, so a missing deadline fails this test instead of hanging it.
      read = await Promise.race([reading, drain().then(() => "still waiting")])
    } finally {
      jest.useRealTimers()
    }
    expect(read).toBe(
      "[Sixb] Cannot read the dataset versions projections applied, so markings cannot be enforced: [Sixb] Reading the dataset versions projections applied took longer than 0.04s."
    )

    app.apply(await app.normalized())
    release()

    // The abandoned refresh listed the Day 1 version: only the next one publishes.
    expect(await app.applied.current()).toBe(NO_APPLIED_MARKINGS)
  })

  // Reproduce: drop the warned cleanup from publish; the second seal is not reported.
  test("a projection sealed again after a compliant version warns again", async () => {
    const app = await setup()
    app.apply(await app.normalized(null))
    await app.applied.current()

    app.apply(await app.normalized())
    app.applied.invalidate()
    await app.applied.current()

    app.apply(await app.normalized(null))
    app.applied.invalidate()
    await app.applied.current()

    expect(warn).toHaveBeenCalledTimes(2)
  })

  test("snapshots refuse writes, since every reader shares them", async () => {
    const app = await setup()
    app.apply(await app.normalized(null))
    const snapshot = await app.applied.current()
    const seal = snapshot.types.get("Invoice")?.[0]

    const writes = [
      () => (NO_APPLIED_MARKINGS.markings as Set<string>).add("pii"),
      () => (NO_APPLIED_MARKINGS.types as Map<string, never>).set("Invoice", [] as never),
      () => (snapshot.markings as Set<string>).clear(),
      () => (snapshot.properties.get("Invoice") as Map<string, Set<string>>).delete("title"),
      () => (snapshot.properties.get("Invoice")?.get("title") as Set<string>).add("pii"),
      () => (seal?.markings as Set<string>).delete("financial"),
      () => (snapshot.types.get("Invoice") as unknown[]).push(seal),
    ]
    for (const write of writes) expect(write).toThrow(TypeError)
    expect(plain(snapshot).markings).toEqual(["financial"])
  })
})
