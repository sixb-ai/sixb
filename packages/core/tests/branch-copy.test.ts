import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  can,
  change,
  col,
  defineDataset,
  defineGroup,
  defineRole,
  InMemoryLakeStorage,
  project,
  resolveAuthorizationContext,
  SixbHost,
} from "../src"
import { copyForBranch } from "../src/branches/copy"
import { readBranchCopy } from "../src/branches/wire"
import { liveLakeSlices } from "../src/datasets/lake-slices"
import type { LakeForks } from "../src/lake-storage"
import { createTestSixb } from "../src/testing"
import { createTestRuntimeDeps } from "./test-runtime-deps"

const orders = defineDataset("copy.orders", {
  schema: [col("id", "string"), col("total", "float64")],
  primaryKey: "id",
})
const developers = defineGroup("developers")
const viewers = defineGroup("viewers")
const roles = [
  defineRole("developers", {
    grantedTo: [developers],
    grants: [can.manage(project.source), can.view(orders)],
  }),
  defineRole("viewers", { grantedTo: [viewers], grants: [can.view(orders)] }),
]

/** A lake whose slices write a catalog file and record their files, as DuckLake does. */
class ForkableLake extends InMemoryLakeStorage {
  readonly forks: LakeForks = {
    currentPoint: async () => "point-1",
    versionsAt: async ({ datasetIds }) =>
      new Map(
        await Promise.all(
          datasetIds.map(async (id) => [id, await this.getLatestVersion(id)] as const)
        )
      ),
    writeSlice: async (input) => {
      const files = new Set(input.versions.map((version) => `${version.versionId}.parquet`))
      await input.record(files)
      await Bun.write(input.path, "catalog")
      return files
    },
    openFile: async () => null,
    releaseFiles: async () => 0,
  }
}

let directory: string
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "sixb-branch-copy-"))
})
afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

async function production() {
  const host = new SixbHost({
    id: "branch-copy",
    ontology: [],
    datasets: [orders],
    groups: [developers, viewers],
    roles,
    ...createTestRuntimeDeps(),
    lakeStorage: new ForkableLake(),
  })
  await createTestSixb(host).datasets.ingest(orders, {
    changes: [change.upsert({ id: "o-1", total: 1 })],
  })
  const person = (groupId: string) =>
    resolveAuthorizationContext({
      principal: { type: "user", id: "usr_alice" },
      groupIds: [groupId],
      roles: host.definitions.security.listResolvedRoles(),
    })
  const copy = (groupId: string = developers.id) =>
    copyForBranch(host, {
      person: person(groupId),
      branch: "feature/x",
      requestId: "req_copy",
      directory,
    })
  const live = () =>
    host.storage.lakeSlices!.listLive({ projectId: host.id, liveAfter: new Date(0) })
  return { host, copy, live }
}

describe("a copy for a branch", () => {
  // Red check: in `copyForBranch`, keep the slice of a copy that did not complete.
  test("leaves no slice when the branch goes away before its end", async () => {
    const { copy, live } = await production()
    const parts = copy()

    // Read up to the lake slice's first part: the slice is cut, the copy not received whole.
    for (let next = await parts.next(); !next.done; next = await parts.next()) {
      if (next.value[0] !== 1) break
    }
    expect(await live()).toHaveLength(1)
    await parts.return(undefined)

    expect(await live()).toEqual([])
  })

  // Red check: in `copyForBranch`, record no credential hash with the slice.
  test("hands the branch a credential its slice records, and only by its hash", async () => {
    const { copy, live } = await production()
    const chunks: Uint8Array[] = []
    for await (const part of copy()) chunks.push(part)

    const received = readBranchCopy(
      (async function* () {
        yield* chunks
      })()
    )
    for await (const _ of received.snapshot) void _
    const rest = await received.rest()
    const [slice] = await live()

    expect(rest?.lake.credential).toStartWith("sixb_branch_")
    expect(slice?.credentialHash).toBe(
      createHash("sha256").update(`${rest?.lake.credential}`).digest("hex")
    )
  })

  // Red check: drop the grant check from `copyForBranch`.
  test("refuses a person who may not manage the project's source", async () => {
    const { copy, live } = await production()
    const refused = await copy(viewers.id)
      .next()
      .catch((error: unknown) => error)

    expect(String(refused)).toContain("can.manage(project.source)")
    expect(await live()).toEqual([])
  })

  // Red check: in `liveLakeSlices`, drop the `isUnreceivedCopy` filter: retention keeps the files
  // of a copy no branch ever held.
  test("lets the slice of a copy no branch confirmed lapse within the hour", async () => {
    const { host } = await production()
    const hourAgo = new Date(Date.now() - 61 * 60_000)
    const slice = (id: string, extra: object = {}) =>
      host.storage.lakeSlices!.create({
        id,
        projectId: host.id,
        userId: "usr_alice",
        branch: "feature/x",
        point: "point",
        versions: [],
        files: [],
        createdAt: hourAgo,
        ...extra,
      })
    await slice("slice_unconfirmed", { credentialHash: "a".repeat(64) })
    await slice("slice_confirmed", { credentialHash: "b".repeat(64), receivedAt: hourAgo })
    // A slice cut for no branch credential keeps its own rule.
    await slice("slice_plain")
    await slice("slice_fresh", { credentialHash: "c".repeat(64), createdAt: new Date() })

    const ids = (await liveLakeSlices(host)).map((live) => live.id).sort()
    expect(ids).toEqual(["slice_confirmed", "slice_fresh", "slice_plain"])
  })
})
