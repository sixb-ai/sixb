import { afterAll, afterEach, describe, expect, spyOn, test } from "bun:test"
import type { DatasetVersion } from "../src/lake-storage"
import { createAppliedMarkings } from "../src/security/applied-markings"
import {
  type AppliedMarkingsSnapshot,
  NO_APPLIED_MARKINGS,
} from "../src/security/applied-markings-snapshot"
import { getDatasetVersionMarkings } from "../src/security/internal"
import { createAppliedProject, type InvoiceProjection, projectId } from "./applied-markings-fixture"

// What the dataset versions projections applied add to the ontology's markings, and how the host
// keeps that snapshot current: read lazily, refreshed on a timer with one storage query, and
// reclassified only where an applied version changed.

const INTERVAL_MS = 5_000

const warn = spyOn(console, "warn").mockImplementation(() => {})
afterEach(() => warn.mockClear())
afterAll(() => warn.mockRestore())

/** The host's resolver, its lake, and its sources, behind a hand-driven clock and timer. */
async function setup(
  options: {
    readonly variant?: InvoiceProjection
    readonly marked?: boolean
    readonly intervalMs?: number
  } = {}
) {
  const project = await createAppliedProject(options)
  const versionMarkings = getDatasetVersionMarkings(project.host)
  const calls = { listActive: 0, getVersion: 0, classify: 0, scheduled: 0, stopped: 0 }
  const clock = { now: 0 }
  const ticks: (() => void)[] = []
  let failure: Error | undefined
  let lakeFailure: Error | undefined
  let storageGate: Promise<void> | undefined
  let lakeGate: Promise<void> | undefined
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
    refreshIntervalMs: options.intervalMs ?? INTERVAL_MS,
    now: () => clock.now,
    schedule: (tick) => {
      calls.scheduled += 1
      ticks.push(tick)
      return () => {
        calls.stopped += 1
      }
    },
  })
  return {
    ...project,
    applied,
    calls,
    clock,
    /** Run one background refresh to its end. */
    async tick() {
      for (const tick of ticks) tick()
      // The refresh runs in the background: let it reach its end.
      await Bun.sleep(5)
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
    holdLake(): () => void {
      let release = () => {}
      lakeGate = new Promise((resolve) => {
        release = resolve
      })
      return () => {
        lakeGate = undefined
        release()
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
  test("a project without marked columns reads nothing and starts no timer", async () => {
    const app = await setup({ marked: false })
    app.apply(await app.normalized(titleFromAmount))

    expect(app.applied.affects(new Set())).toBe(false)
    expect(await app.applied.current()).toBe(NO_APPLIED_MARKINGS)
    expect(app.calls).toMatchObject({ listActive: 0, scheduled: 0 })
  })

  test("a compliant applied version adds nothing and is classified once", async () => {
    const app = await setup()
    app.apply(await app.normalized())

    expect(app.applied.affects(new Set())).toBe(true)
    expect(app.applied.affects(new Set(["financial"]))).toBe(false)
    expect(await app.applied.current()).toBe(NO_APPLIED_MARKINGS)
    expect(app.calls).toMatchObject({ listActive: 1, classify: 1, scheduled: 1 })

    // Reproduce: drop the `previous.key === key` reuse in createAppliedMarkings' read; every tick
    // classifies the version again.
    for (let index = 0; index < 3; index += 1) await app.tick()
    expect(app.calls).toMatchObject({ listActive: 4, classify: 1, scheduled: 1 })
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
    await app.tick()
    expect(await app.applied.current()).toBe(NO_APPLIED_MARKINGS)
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
    await app.tick()
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
    await app.tick()
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
    await app.tick()
    expect(await app.applied.current()).toBe(NO_APPLIED_MARKINGS)
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

    await app.tick()
    expect(await app.applied.current()).toBe(first)

    // A version the lake cannot read is read again on every refresh, to the same result.
    app.failLake(new Error("lake offline"))
    app.apply(await app.normalized())
    await app.tick()
    const sealed = await app.applied.current()
    expect(sealed).not.toBe(first)
    const reads = app.calls.getVersion
    await app.tick()
    expect(app.calls.getVersion).toBe(reads + 1)
    expect(await app.applied.current()).toBe(sealed)
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

  // Reproduce: drop the age condition from the catch in current(); the late read resolves.
  test("a failed refresh keeps the snapshot until the bound, then reads fail closed", async () => {
    const app = await setup()
    app.apply(await app.normalized(titleFromAmount))
    const snapshot = await app.applied.current()

    app.failStorage(new Error("storage offline"))
    await app.tick()
    await app.tick()
    expect(warn.mock.calls).toEqual([
      [
        "[Sixb] Could not read the dataset versions projections applied: storage offline. Reads keep the markings read before for 10s, then fail until it succeeds.",
      ],
    ])
    app.clock.now = 2 * INTERVAL_MS
    expect(await app.applied.current()).toBe(snapshot)

    app.clock.now = 2 * INTERVAL_MS + 1
    await expect(app.applied.current()).rejects.toThrow(
      "[Sixb] Cannot read the dataset versions projections applied, so markings cannot be enforced: storage offline"
    )

    app.failStorage()
    expect(await app.applied.current()).toBe(snapshot)
    // A new streak of failures warns again.
    app.failStorage(new Error("storage offline"))
    await app.tick()
    expect(warn).toHaveBeenCalledTimes(2)
  })

  test("a first read that cannot read the applied versions fails", async () => {
    const app = await setup()
    app.failStorage(new Error("storage offline"))
    await expect(app.applied.current()).rejects.toThrow("storage offline")
    expect(app.calls.scheduled).toBe(0)
  })

  test("stopping the refresh stops the timer, and the next read starts it again", async () => {
    const app = await setup()
    app.apply(await app.normalized())
    await app.applied.current()
    app.applied.stopRefreshing()
    expect(app.calls.stopped).toBe(1)

    app.applied.invalidate()
    await app.applied.current()
    expect(app.calls.scheduled).toBe(2)
  })

  // Reproduce: drop the idle check from tick in createAppliedMarkings; the host keeps listing the
  // sources.
  test("a host no read needs stops refreshing", async () => {
    const app = await setup()
    app.apply(await app.normalized())
    await app.applied.current()

    app.clock.now = 11 * INTERVAL_MS
    await app.tick()
    expect(app.calls).toMatchObject({ listActive: 2, stopped: 0 })
    app.clock.now = 12 * INTERVAL_MS + 1
    await app.tick()
    expect(app.calls).toMatchObject({ listActive: 2, stopped: 1 })
  })

  // Reproduce: bump the generation in invalidate only once a snapshot exists; the first read's
  // snapshot is returned, with the Day 1 title.
  test("a projection applied while the first snapshot is read is read by the next read", async () => {
    const app = await setup()
    app.apply(await app.normalized(titleFromAmount))
    const release = app.holdLake()
    const first = app.applied.current()
    await Bun.sleep(1)

    app.apply(await app.normalized())
    app.applied.invalidate()
    release()
    await first
    expect(await app.applied.current()).toBe(NO_APPLIED_MARKINGS)
  })

  // Reproduce: drop the deadline from refresh in createAppliedMarkings; the read never settles.
  test("a refresh that hangs fails reads at its deadline, and a late answer is discarded", async () => {
    const app = await setup({ intervalMs: 20 })
    app.apply(await app.normalized(titleFromAmount))
    const release = app.holdStorage()

    // Bounded here too, so a missing deadline fails this test instead of hanging it.
    const read = await Promise.race([
      app.applied.current().then(
        () => "resolved",
        (error: Error) => error.message
      ),
      Bun.sleep(1_000).then(() => "still waiting"),
    ])
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
