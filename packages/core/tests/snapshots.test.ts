import { afterEach, describe, expect, jest, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createTestingScope } from "../src/execution/scopes"
import type { AppliedMarkings } from "../src/security/applied-markings"
import { NO_APPLIED_MARKINGS } from "../src/security/applied-markings-snapshot"
import {
  exportSnapshot,
  hostSnapshotSource,
  readSnapshotFile,
  writeSnapshotFile,
} from "../src/snapshots"
import { deploy, projectId, readAll } from "./helpers/snapshot-desk"

afterEach(() => {
  jest.useRealTimers()
})

describe("a snapshot holds what one person reads", () => {
  // Reproduce: return the unscoped store from objectStorageForAuthority for a principal, and the
  // hidden ticket and the team's link to it appear in the bytes.
  test("a view condition keeps the objects it hides, and the links to them, in production", async () => {
    const { host, optionsFor } = await deploy()
    const { records, text } = await readAll(
      exportSnapshot(hostSnapshotSource(host), optionsFor(["agents"]))
    )

    const ids = records.flatMap((record) => (record.kind === "objects" ? record.ids : []))
    expect(ids.sort()).toEqual(["t-mine", "t-open", "team-1"])

    const links = records.flatMap((record) =>
      record.kind === "links" ? record.rows.map((row) => `${record.sourceTypeId}:${row[3]}`) : []
    )
    expect(links.sort()).toEqual(["team:t-mine", "team:t-open", "ticket:team-1", "ticket:team-1"])
    expect(text).not.toContain("t-hidden")
    expect(text).not.toContain("Payroll leak")
  })

  // Reproduce: drop the redactObjectRow call in readSnapshotPage, and the notes and codes leave;
  // drop both the `readable` check in exportedVectorProfiles and the source fingerprint check in
  // readVectors, and so does the vector of the notes.
  test("a marking keeps its values, and the vectors and unique values made of them, in production", async () => {
    const { host, optionsFor } = await deploy()
    const { records, text } = await readAll(
      exportSnapshot(hostSnapshotSource(host), optionsFor(["agents"]))
    )

    expect(text).not.toContain("secret-")
    const manifest = records[0]
    expect(
      manifest?.kind === "manifest" && manifest.types.find((t) => t.objectTypeId === "ticket")
    ).toMatchObject({ hiddenPropertyIds: ["code", "notes"], throughCondition: true })

    // The title vector leaves; the vector computed from the notes does not.
    const profiles = records.flatMap((record) =>
      record.kind === "vectors" ? [record.profile] : []
    )
    expect(profiles).toEqual(["titles"])
  })

  // Reproduce: return true from canViewUsers in readerSnapshotScope, and Bob comes along.
  test("a person who cannot view the members takes only themselves and their groups", async () => {
    const { host, optionsFor } = await deploy()

    const agent = await readAll(exportSnapshot(hostSnapshotSource(host), optionsFor(["agents"])))
    const members = agent.records.find((record) => record.kind === "members")
    expect(members).toEqual({
      kind: "members",
      users: [
        [
          "usr_alice",
          "usr_alice@example.com",
          null,
          null,
          "active",
          expect.any(Number),
          expect.any(Number),
        ],
      ],
      memberships: [["usr_alice", "agents", "manual", expect.any(Number)]],
    })

    const manager = await readAll(
      exportSnapshot(
        hostSnapshotSource(host),
        optionsFor(["managers"], { type: "user", id: "usr_bob" })
      )
    )
    const everyone = manager.records.find((record) => record.kind === "members")
    expect(everyone?.kind === "members" && everyone.users.map((user) => user[0]).sort()).toEqual([
      "usr_alice",
      "usr_bob",
    ])
  })

  test("a type the person cannot read is left out, and said so", async () => {
    const { host, optionsFor } = await deploy()
    const { records, text } = await readAll(
      exportSnapshot(hostSnapshotSource(host), optionsFor(["agents"]))
    )
    expect(text).not.toContain("inv-1")

    const manifest = records[0]
    expect(manifest?.kind === "manifest" && manifest.unreadableTypeIds).toEqual(["invoice"])
  })

  // The version applied is absent here: no projection ran, and the snapshot cut no lake slice, so
  // the type travels as created objects, which its projection cannot update on the branch.
  test("a type a projection feeds says so, and whether the person reads its dataset", async () => {
    const { host, optionsFor } = await deploy()
    const manager = await readAll(
      exportSnapshot(
        hostSnapshotSource(host),
        optionsFor(["managers"], { type: "user", id: "usr_bob" })
      )
    )
    const manifest = manager.records[0]
    const invoice =
      manifest?.kind === "manifest"
        ? manifest.types.find((type) => type.objectTypeId === "invoice")
        : undefined
    expect(invoice?.projection).toEqual({
      projectionId: "snapshot_invoices",
      datasetId: "snapshot_books",
      datasetView: true,
      notReprojectable: "the branch does not read production's datasets in place",
    })
  })

  test("a snapshot is taken as a user", async () => {
    const { host } = await deploy()
    const refused = await readAll(
      exportSnapshot(hostSnapshotSource(host), { scope: createTestingScope({ projectId }) })
    ).catch((error: unknown) => error)

    expect(String(refused)).toContain("taken as one person")
  })
})

describe("a snapshot in a file", () => {
  // Reproduce: drop the `ended` check from decodeSnapshot, and the cut file reads as complete.
  test("a file holds a snapshot, and a cut one is refused", async () => {
    const { host, optionsFor } = await deploy()
    const directory = await mkdtemp(join(tmpdir(), "sixb-snapshot-"))

    try {
      const path = join(directory, "production.sixbsnap")
      const written = await writeSnapshotFile(
        path,
        exportSnapshot(hostSnapshotSource(host), optionsFor(["agents"]))
      )
      expect(written.bytes).toBeGreaterThan(0)

      const { records } = await readAll(readSnapshotFile(path))
      expect(records.at(-1)?.kind).toBe("end")

      const bytes = await Bun.file(path).bytes()
      await writeFile(path, bytes.subarray(0, bytes.length - 3))
      const cut = await readAll(readSnapshotFile(path)).catch((error: unknown) => error)
      expect(String(cut)).toContain("The snapshot is incomplete")
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})

describe("production's side of a snapshot", () => {
  // Reproduce: drop the applied-sources check from takeSnapshot, and the first attempt reads
  // under a clearance built from versions other than those applied at S.
  test("a clearance built from other versions than S's is resolved again", async () => {
    const { host, optionsFor } = await deploy()
    const source = hostSnapshotSource(host)
    const manager = optionsFor(["managers"], { type: "user", id: "usr_bob" })

    let reads = 0
    const moving = (keys: readonly string[]): AppliedMarkings => ({
      affects: () => false,
      current: async () => NO_APPLIED_MARKINGS,
      invalidate: () => {},
      forEventOrigin: async (snapshot) => snapshot,
      forEarlierValues: (snapshot) => snapshot,
      appliedSources: () => keys[Math.min(reads++, keys.length - 1)],
    })

    // The books' projection applied a version while the first clearance was built: S has none.
    const taken = await readAll(
      exportSnapshot({ ...source, appliedMarkings: moving(['[["moved"]]', "[]"]) }, manager)
    )
    expect(reads).toBe(2)
    expect(taken.records.at(-1)?.kind).toBe("end")

    const stuck = await readAll(
      exportSnapshot({ ...source, appliedMarkings: moving(['[["moved"]]']) }, manager)
    ).catch((error: unknown) => error)
    expect(String(stuck)).toContain("kept applying new dataset versions")
  })

  // Reproduce: remove withinDuration from writeSnapshot, and the stalled export never ends.
  test("a consumer that stops reading ends the snapshot at its duration cap", async () => {
    const { host, optionsFor } = await deploy()
    jest.useFakeTimers()

    const snapshot = exportSnapshot(hostSnapshotSource(host), {
      ...optionsFor(["managers"], { type: "user", id: "usr_bob" }),
      concurrency: 1,
      pageSize: 1,
      maxDurationMs: 1_000,
    })
    await snapshot.next()
    await snapshot.next()

    jest.advanceTimersByTime(1_001)
    const ended = await (async () => {
      for await (const _ of snapshot) {
        // Drains the frames read before the cap.
      }
    })().catch((error: unknown) => error)

    expect(String(ended)).toContain("still being read after 1000 ms")
  })
})
