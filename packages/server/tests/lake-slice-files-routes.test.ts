import { afterEach, describe, expect, setSystemTime, test } from "bun:test"
import {
  can,
  change,
  col,
  defineDataset,
  defineGroup,
  defineRole,
  InMemoryBlobStorage,
  InMemoryBroker,
  InMemoryLakeStorage,
  InMemoryQueues,
  InMemoryStorage,
  resolveAuthorizationContext,
  SixbHost,
} from "@sixb/core"
import { issueLakeSliceToken, writeLakeSlice } from "@sixb/core/internal/lake-slices"
import type { DatasetVersionRef, LakeForks } from "@sixb/core/lake-storage"
import { createTestSixb } from "@sixb/core/testing"
import { createSixbApi, SixbServer } from "../src/server"
import { createTestBrowserPolicy } from "./helpers"

const projectId = "lake-slice-files"
const invoices = defineDataset("erp.invoices", {
  schema: [col("id", "string"), col("total", "float64")],
  primaryKey: "id",
})
const payroll = defineDataset("hr.payroll", {
  schema: [col("id", "string"), col("salary", "float64")],
  primaryKey: "id",
})
const staff = defineGroup("staff")
const reader = defineRole("reader", { grantedTo: [staff], grants: [can.view(invoices)] })

// Ten known bytes per file, so ranges are easy to check.
const content = (path: string) => new TextEncoder().encode(`${path.length}`.padStart(10, "0"))
// Partition values of any text end up in a file's path.
const filePath = ({ datasetId, versionId }: DatasetVersionRef) =>
  `main/${datasetId}/city=São Paulo 50%/${versionId}.parquet`
const encoded = (path: string) => path.split("/").map(encodeURIComponent).join("/")

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
      const files = new Set(input.versions.map(filePath))
      await input.record(files)
      return files
    },
    releaseFiles: async () => 0,
    openFile: async (path) => ({
      sizeBytes: 10,
      read: (range) =>
        new Response(
          range ? content(path).subarray(range.start, range.endInclusive + 1) : content(path)
        ).body as ReadableStream<Uint8Array>,
    }),
  }
}

async function createApp() {
  const lakeStorage = new ForkableLake()
  const host = new SixbHost({
    id: projectId,
    ontology: [],
    datasets: [invoices, payroll],
    broker: new InMemoryBroker(),
    storage: new InMemoryStorage(),
    lakeStorage,
    blobStorage: new InMemoryBlobStorage(),
    queues: new InMemoryQueues(),
    groups: [staff],
    roles: [reader],
    auth: { id: "test", kind: "dev" },
  })
  const trusted = createTestSixb(host)
  await trusted.datasets.ingest(invoices, { changes: [change.upsert({ id: "inv-1", total: 1 })] })
  await trusted.datasets.ingest(payroll, { changes: [change.upsert({ id: "emp-1", salary: 2 })] })

  const person = createTestSixb(host, {
    authorization: resolveAuthorizationContext({
      principal: { type: "user", id: "usr_staff" },
      groupIds: [staff.id],
      roles: host.definitions.security.listResolvedRoles(),
    }),
  })
  const slice = await writeLakeSlice(host, person, {
    point: "point-1",
    path: "/tmp/unused",
    branch: "invoice-reminders",
  })
  const { token, expiresAt } = await issueLakeSliceToken(host, person, { sliceId: slice.id })
  const payrollVersion = await lakeStorage.getLatestVersion(payroll.id)

  const app = createSixbApi(
    new SixbServer({ host, quiet: true, browser: createTestBrowserPolicy() })
  )
  const url = (path: string) => `http://localhost/api/lake/slice-files/${path}`
  return {
    fetch: (path: string, init: RequestInit = {}) =>
      app.fetch(new Request(url(encoded(path)), init)),
    token,
    expiresAt,
    inside: filePath(slice.versions[0] as DatasetVersionRef),
    outside: filePath({ datasetId: payroll.id, versionId: `${payrollVersion?.versionId}` }),
  }
}

afterEach(() => {
  setSystemTime()
})

describe("lake slice file route", () => {
  test("serves a slice's files to its token, whole or by range, without a session", async () => {
    const { fetch, token, inside } = await createApp()
    const authorization = `Bearer ${token}`

    const whole = await fetch(inside, { headers: { authorization } })
    const part = await fetch(inside, { headers: { authorization, range: "bytes=2-5" } })
    const head = await fetch(inside, { method: "HEAD", headers: { authorization } })
    const unsatisfiable = await fetch(inside, { headers: { authorization, range: "bytes=20-30" } })

    expect(whole.status).toBe(200)
    expect(new Uint8Array(await whole.arrayBuffer())).toEqual(content(inside))
    expect(part.status).toBe(206)
    expect(part.headers.get("content-range")).toBe("bytes 2-5/10")
    expect(new Uint8Array(await part.arrayBuffer())).toEqual(content(inside).subarray(2, 6))
    expect(head.status).toBe(200)
    expect(head.headers.get("content-length")).toBe("10")
    expect(unsatisfiable.status).toBe(416)
  })

  test("refuses a file outside the slice, a missing or expired token, and any write", async () => {
    setSystemTime(new Date("2026-11-24T10:00:00.000Z"))
    const { fetch, token, expiresAt, inside, outside } = await createApp()
    const authorization = `Bearer ${token}`

    const missing = await fetch(outside, { headers: { authorization } })
    expect(missing.status).toBe(404)
    expect((await missing.json()).error).toStartWith(
      "[SixbServer] This lake slice holds no such file."
    )
    expect((await fetch(inside)).status).toBe(401)
    expect((await fetch(inside, { headers: { authorization: "Bearer nope" } })).status).toBe(401)
    for (const method of ["PUT", "POST", "DELETE"]) {
      expect((await fetch(inside, { method, headers: { authorization } })).ok).toBe(false)
    }

    setSystemTime(expiresAt)
    const expired = await fetch(inside, { headers: { authorization } })
    expect(expired.status).toBe(401)
    expect(await expired.json()).toEqual({
      error: "[SixbServer] This lake slice token is unknown or expired. Ask for a new one.",
    })
  })

  test("answers a production that cannot serve branches with what it lacks", async () => {
    const host = new SixbHost({
      id: projectId,
      ontology: [],
      datasets: [invoices],
      broker: new InMemoryBroker(),
      storage: new InMemoryStorage(),
      lakeStorage: new InMemoryLakeStorage(),
      blobStorage: new InMemoryBlobStorage(),
      queues: new InMemoryQueues(),
      auth: { id: "test", kind: "dev" },
    })
    const app = createSixbApi(
      new SixbServer({ host, quiet: true, browser: createTestBrowserPolicy() })
    )

    const response = await app.fetch(
      new Request("http://localhost/api/lake/slice-files/main/file.parquet", {
        headers: { authorization: `Bearer ${"x".repeat(43)}` },
      })
    )

    expect(response.status).toBe(501)
    expect((await response.json()).error).toContain("cannot be read from a branch")
  })
})
