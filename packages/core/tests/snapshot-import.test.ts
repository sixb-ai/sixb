import { describe, expect, test } from "bun:test"
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { defineObjectType, type EmbeddingModel, link, OntologyRegistry, prop, ref } from "../src"
import {
  branchNamespaces,
  exportSnapshot,
  hostSnapshotSource,
  importSnapshot,
  readSnapshotFile,
  spoolSnapshot,
  writeSnapshotFile,
} from "../src/snapshots"
import { InMemoryStorage, type Storage } from "../src/storage"
import {
  confidential,
  deploy,
  Invoice,
  names,
  projectId,
  readAll,
  Team,
  Ticket,
} from "./helpers/snapshot-desk"

function importInto(storage: Storage, chunks: readonly Uint8Array[], ontology?: OntologyRegistry) {
  return importSnapshot({
    snapshot: (async function* () {
      yield* chunks
    })(),
    storage,
    ontology: ontology ?? new OntologyRegistry({ sources: [Team, Ticket, Invoice] }),
  })
}

describe("what an import reports of what the person read", () => {
  test("properties hidden from the person are said so, with what was imported", async () => {
    const { host, optionsFor } = await deploy()
    const { chunks } = await readAll(
      exportSnapshot(hostSnapshotSource(host), optionsFor(["agents"]))
    )

    const report = await importInto(new InMemoryStorage(), chunks)
    expect(report.types.find((type) => type.objectTypeId === "ticket")).toMatchObject({
      objects: 2,
      links: 2,
      vectors: 2,
      hiddenPropertyIds: ["code", "notes"],
    })
    expect(report.skipped).toEqual([
      { objectTypeId: "invoice", reason: "the person who took it cannot read this type" },
    ])
  })

  test("a type a projection feeds is named, imported as created objects", async () => {
    const { host, optionsFor } = await deploy()
    const manager = await readAll(
      exportSnapshot(
        hostSnapshotSource(host),
        optionsFor(["managers"], { type: "user", id: "usr_bob" })
      )
    )

    const report = await importInto(new InMemoryStorage(), manager.chunks)
    expect(report.types.find((type) => type.objectTypeId === "invoice")).toMatchObject({
      objects: 1,
      projectionId: "snapshot_invoices",
    })
  })

  // Reproduce: drop assertComplete from importSnapshot, and a stream missing a page imports.
  test("a stream whose end counts more than it holds is refused", async () => {
    const { host, optionsFor } = await deploy()
    const { records } = await readAll(
      exportSnapshot(hostSnapshotSource(host), optionsFor(["agents"]))
    )
    const { encodeSnapshotFrame, SNAPSHOT_SIGNATURE } = await import("../src/snapshots/format")

    // The frames of the export, less its first page of tickets.
    const firstTickets = records.findIndex(
      (record) => record.kind === "objects" && record.objectTypeId === "ticket"
    )
    const frames = [
      SNAPSHOT_SIGNATURE,
      ...(await Promise.all(
        records
          .filter((_, index) => index !== firstTickets)
          .map((record) => encodeSnapshotFrame(record, { compress: true }))
      )),
    ]

    const refused = await importInto(new InMemoryStorage(), frames).catch((error: unknown) => error)
    expect(String(refused)).toContain("it says it holds")
  })
})

describe("importing a snapshot into a branch", () => {
  test("each type is checked against the branch's definitions", async () => {
    const { host, optionsFor } = await deploy()
    const { chunks } = await readAll(
      exportSnapshot(
        hostSnapshotSource(host),
        optionsFor(["managers"], { type: "user", id: "usr_bob" })
      )
    )

    // The branch renamed nothing on teams, but dropped `name` and the escalations link; it made
    // the ticket's status a number; and it no longer has invoices.
    const BranchTeam = defineObjectType({
      id: "team",
      name: "Team",
      properties: [prop("id", "string", { required: true, primary: true })],
    })
    const BranchTicket = defineObjectType({
      id: "ticket",
      name: "Ticket",
      properties: [
        prop("id", "string", { required: true, primary: true }),
        prop("status", "integer"),
      ],
    })
    const branch = new InMemoryStorage()
    const report = await importInto(
      branch,
      chunks,
      new OntologyRegistry({ sources: [BranchTeam, BranchTicket] })
    )

    expect(report.skipped).toEqual([
      { objectTypeId: "invoice", reason: "the branch no longer defines this type" },
      { objectTypeId: "ticket", reason: "property 'status' changed its type or mode" },
    ])
    expect(report.types).toEqual([
      expect.objectContaining({
        objectTypeId: "team",
        objects: 1,
        links: 0,
        droppedPropertyIds: ["name"],
        droppedLinks: 3,
      }),
    ])
    const team = await branch.objects.getByPrimaryId({
      projectId,
      objectTypeId: "team",
      primaryId: "team-1",
    })
    expect(team?.properties).toEqual({ id: "team-1" })
  })

  test("vectors are kept only where the branch embeds them as production did", async () => {
    const { host, optionsFor } = await deploy()
    const manager = optionsFor(["managers"], { type: "user", id: "usr_bob" })
    const { chunks } = await readAll(exportSnapshot(hostSnapshotSource(host), manager))

    const other: EmbeddingModel = {
      ...names,
      modelId: "snapshot-tickets-v2",
      definition: { ...names.definition, modelId: "snapshot-tickets-v2" },
    }
    const BranchTicket = defineObjectType({
      id: "ticket",
      name: "Ticket",
      properties: [
        prop("id", "string", { required: true, primary: true }),
        prop("status", "string", { query: { searchable: true, filterable: true } }),
        prop("owner", ref.user(), {
          nullable: true,
          query: { searchable: true, filterable: true },
        }),
        prop("title", "string"),
        prop("notes", "string", { markings: [confidential] }),
        prop("code", "string", { unique: true, markings: [confidential] }),
      ],
      links: [link("team", Team, { cardinality: "one" })],
      search: { vectors: { titles: { source: ["title"], model: other } } },
    })
    const report = await importInto(
      new InMemoryStorage(),
      chunks,
      new OntologyRegistry({ sources: [Team, BranchTicket, Invoice] })
    )
    expect(report.types.find((type) => type.objectTypeId === "ticket")).toMatchObject({
      vectors: 0,
      skippedVectors: [
        {
          profile: "titles",
          reason: "the branch embeds it differently: its vectors are computed again",
        },
        { profile: "notes", reason: "the branch no longer defines this profile" },
      ],
    })

    // A target that names the configurations it accepts receives no other vector.
    const none = await readAll(
      exportSnapshot(hostSnapshotSource(host), { ...manager, vectorConfigurations: [] })
    )
    expect(none.records.some((record) => record.kind === "vectors")).toBe(false)
  })

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

      const report = await importSnapshot({
        snapshot: readSnapshotFile(path),
        storage: await branchNamespaces(host.storage).createBranchNamespace("from-file"),
        ontology: new OntologyRegistry({ sources: [Team, Ticket, Invoice] }),
      })
      expect(report.types.map((type) => type.objects)).toEqual([1, 2])

      const bytes = await Bun.file(path).bytes()
      await writeFile(path, bytes.subarray(0, bytes.length - 3))
      const cut = await importSnapshot({
        snapshot: readSnapshotFile(path),
        storage: new InMemoryStorage(),
        ontology: new OntologyRegistry({ sources: [Team, Ticket, Invoice] }),
      }).catch((error: unknown) => error)
      expect(String(cut)).toContain("The snapshot is incomplete")
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test("a spooled snapshot reads from its file, which goes once read", async () => {
    const { host, optionsFor } = await deploy()
    const directory = await mkdtemp(join(tmpdir(), "sixb-spool-"))

    try {
      const report = await importSnapshot({
        snapshot: spoolSnapshot(
          exportSnapshot(hostSnapshotSource(host), optionsFor(["agents"])),
          directory
        ),
        storage: new InMemoryStorage(),
        ontology: new OntologyRegistry({ sources: [Team, Ticket, Invoice] }),
      })
      expect(report.types.map((type) => type.objects)).toEqual([1, 2])
      expect(await readdir(directory)).toEqual([])
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test("a storage that cannot isolate a branch is refused", () => {
    const storage = new InMemoryStorage()
    const plain = { ...storage, ping: () => storage.ping() } as unknown as Storage

    expect(() => branchNamespaces(plain)).toThrow("cannot isolate a branch")
  })
})
