import { afterEach, describe, expect, test } from "bun:test"
import { MicrosoftApiError, MicrosoftConfigurationError, MicrosoftProtocolError } from "../src"
import { apiError, collect, connect, GRAPH, json, mockFetch, restoreFetch } from "./helpers"

afterEach(restoreFetch)

describe("sites and drive items", () => {
  test("resolves an encoded site URL and lists all libraries through opaque nextLink URLs", async () => {
    const next = `${GRAPH}sites/site/drives?$skiptoken=a%2Bb%3D&$top=2`
    const responses = [
      json({ id: "site" }),
      json({ value: [{ id: "a" }], "@odata.nextLink": next }),
      json({ value: [{ id: "b" }] }),
    ]
    const requests = mockFetch(() => responses.shift()!)
    const client = await connect()
    const site = await client.sites.getByUrl("https://contoso.sharepoint.com/sites/Projet%20A/")
    const drives = await collect(client.sites.listAllDrives(site.id, { top: 2, select: ["name"] }))
    expect(drives.map((d) => d.id)).toEqual(["a", "b"])
    expect(requests[0].url).toBe(`${GRAPH}sites/contoso.sharepoint.com:/sites/Projet%20A`)
    expect(new URL(requests[1].url).searchParams.get("$select")).toBe("id,name")
    expect(requests[2].url).toBe(next)
  })

  test("root sites, drive IDs, root folders and file paths use the correct Graph routes", async () => {
    const requests = mockFetch(() => json({ id: "id" }))
    const client = await connect()
    await client.sites.getByUrl("https://contoso.sharepoint.com/")
    await client.drives.get("drive+id")
    await client.drives.items.get("drive", "root")
    await client.drives.items.get("drive", "file/id")
    await client.drives.items.getByPath("drive", "Documents/Résumé #1 100%.txt")
    expect(requests.map((r) => r.url)).toEqual([
      `${GRAPH}sites/contoso.sharepoint.com`,
      `${GRAPH}drives/drive%2Bid`,
      `${GRAPH}drives/drive/root`,
      `${GRAPH}drives/drive/items/file%2Fid`,
      `${GRAPH}drives/drive/root:/Documents/R%C3%A9sum%C3%A9%20%231%20100%25.txt`,
    ])
  })

  test("folder navigation handles empty pages with a continuation", async () => {
    let calls = 0
    mockFetch(() =>
      ++calls === 1
        ? json({ value: [], "@odata.nextLink": `${GRAPH}drives/d/root/children?$skiptoken=next` })
        : json({ value: [{ id: "file" }] })
    )
    const client = await connect()
    expect(await collect(client.drives.items.listAllChildren("d"))).toEqual([{ id: "file" }])
    expect(calls).toBe(2)
  })

  // Countercheck: remove graphUrl's origin guard in src/validation.ts; this must fail.
  test("hostile pagination cannot send the Graph token to another origin", async () => {
    const requests = mockFetch(() =>
      json({ value: [], "@odata.nextLink": "https://attacker.example/v1.0/steal" })
    )
    const client = await connect()
    await expect(collect(client.sites.listAllDrives("site"))).rejects.toBeInstanceOf(
      MicrosoftProtocolError
    )
    expect(requests).toHaveLength(1)
  })

  test("repeated and malformed collections fail instead of truncating or looping", async () => {
    const requests = mockFetch(() =>
      json({ value: [], "@odata.nextLink": `${GRAPH}sites/site/drives` })
    )
    const client = await connect()
    await expect(collect(client.sites.listAllDrives("site"))).rejects.toBeInstanceOf(
      MicrosoftProtocolError
    )
    expect(requests).toHaveLength(1)
    for (const bad of [{}, { value: null }, { value: [{}] }, { value: [], "@odata.nextLink": 5 }]) {
      mockFetch(() => json(bad))
      await expect(client.sites.listDrives("site")).rejects.toBeInstanceOf(MicrosoftProtocolError)
    }
  })

  // Countercheck: make http.media use the authenticated REST client; this must fail.
  test("download redirects never forward Graph bearer credentials, even back to the same origin", async () => {
    const responses = [
      new Response(null, {
        status: 302,
        headers: { location: `${GRAPH}temporary-download?secret=signed` },
      }),
      new Response(null, {
        status: 302,
        headers: { location: "https://files.1drv.com/download?signed=1" },
      }),
      new Response(Uint8Array.from([0, 127, 255])),
    ]
    const requests = mockFetch(() => responses.shift()!)
    const client = await connect()
    expect(Array.from(await client.drives.items.download("d", "f"))).toEqual([0, 127, 255])
    expect(requests[0].headers.get("authorization")).toBe("Bearer graph-token")
    for (const r of requests.slice(1)) {
      expect(r.headers.has("authorization")).toBe(false)
      expect(r.init.credentials).toBe("omit")
    }
    expect(requests.every((r) => r.init.redirect === "manual")).toBe(true)
  })

  test("downloadResponse exposes streaming data, rejects unsafe redirects and terminates cycles", async () => {
    const client = await connect()
    mockFetch(() => new Response("stream"))
    const response = await client.drives.items.downloadResponse("d", "f")
    expect(await response.text()).toBe("stream")
    mockFetch(
      () => new Response(null, { status: 302, headers: { location: "http://files.example/file" } })
    )
    await expect(client.drives.items.download("d", "f")).rejects.toBeInstanceOf(
      MicrosoftProtocolError
    )
    const requests = mockFetch(
      () => new Response(null, { status: 302, headers: { location: "https://files.example/file" } })
    )
    await expect(client.drives.items.download("d", "f")).rejects.toBeInstanceOf(
      MicrosoftProtocolError
    )
    expect(requests).toHaveLength(6)
  })

  test("creates, renames, moves to the actual root ID and deletes with concurrency guards", async () => {
    const requests = mockFetch((r) =>
      r.method === "DELETE"
        ? new Response(null, { status: 204 })
        : json({ id: r.url.includes("/root?") ? "actual-root-id" : "folder" })
    )
    const client = await connect()
    await client.drives.items.createFolder("d", "root", "Folder")
    await client.drives.items.rename("d", "folder", "Renamed", { ifMatch: '"etag-1"' })
    await client.drives.items.move("d", "folder", "root", { name: "Moved", ifMatch: '"etag-2"' })
    await client.drives.items.delete("d", "folder", { ifMatch: '"etag-3"' })
    expect(JSON.parse(String(requests[0].init.body))).toEqual({
      name: "Folder",
      folder: {},
      "@microsoft.graph.conflictBehavior": "fail",
    })
    expect(requests[1].headers.get("if-match")).toBe('"etag-1"')
    expect(JSON.parse(String(requests[3].init.body))).toEqual({
      parentReference: { id: "actual-root-id" },
      name: "Moved",
    })
    expect(requests[3].headers.get("if-match")).toBe('"etag-2"')
    expect(requests[4].headers.get("if-match")).toBe('"etag-3"')
  })

  // Countercheck: allow every method to retry in src/http.ts; this must fail.
  test("custom retry policies cannot replay mutations, including after 401 or 503", async () => {
    const client = await connect({
      retry: { maxRetries: 3, shouldRetry: () => true, delayMs: () => 0 },
    })
    for (const status of [401, 409, 412, 429, 503]) {
      const requests = mockFetch(() => apiError(status))
      await expect(client.drives.items.rename("d", "f", "x")).rejects.toMatchObject({ status })
      expect(requests).toHaveLength(1)
    }
  })

  test("transient reads retry; error status, provider body and correlation headers survive", async () => {
    let calls = 0
    mockFetch(() =>
      ++calls === 1
        ? apiError(429, "tooManyRequests", { "retry-after": "0" })
        : json({ id: "site" })
    )
    const client = await connect({ retry: { maxRetries: 1 } })
    expect((await client.sites.get("site")).id).toBe("site")
    expect(calls).toBe(2)
    mockFetch(() => apiError(412, "preconditionFailed", { "request-id": "req-1" }))
    const error = await client.drives.items.delete("d", "f").catch((e: unknown) => e)
    expect(error).toBeInstanceOf(MicrosoftApiError)
    expect(error).toMatchObject({
      status: 412,
      code: "preconditionFailed",
      requestId: "req-1",
      body: { error: { message: "Provider detail" } },
    })
  })

  test("invalid paths and parameters are rejected before network I/O", async () => {
    const requests = mockFetch(() => json({ id: "unexpected" }))
    const client = await connect()
    for (const path of ["../secret", "a/../b", "a//b", "/a", "a/", "a\\b", "a/./b"]) {
      await expect(client.drives.items.getByPath("d", path)).rejects.toBeInstanceOf(
        MicrosoftConfigurationError
      )
    }
    await expect(client.sites.listDrives("s", { top: -1 })).rejects.toBeInstanceOf(
      MicrosoftConfigurationError
    )
    await expect(client.drives.items.get("d", "..")).rejects.toBeInstanceOf(
      MicrosoftConfigurationError
    )
    await expect(client.drives.items.delete("d", "f", { ifMatch: "" })).rejects.toBeInstanceOf(
      MicrosoftConfigurationError
    )
    await expect(
      client.drives.uploads.upload("d", { itemId: "f" }, new Blob(["x"]), { ifMatch: "" })
    ).rejects.toBeInstanceOf(MicrosoftConfigurationError)
    await expect(
      client.sites.getByUrl("https://contoso.sharepoint.com/sites/a?file=1")
    ).rejects.toBeInstanceOf(MicrosoftConfigurationError)
    expect(requests).toHaveLength(0)
  })
})

describe("delta synchronization", () => {
  // Countercheck: return after an empty value array in delta.pages; this must fail.
  test("keeps empty pages, deletions and the final opaque checkpoint", async () => {
    const next = `${GRAPH}drives/d/root/delta?token=opaque%2Bpage`
    const checkpoint = `${GRAPH}drives/d/root/delta(token='opaque%3Dcheckpoint')`
    const responses = [
      json({ value: [], "@odata.nextLink": next }),
      json({
        value: [
          { id: "gone", deleted: { state: "deleted" } },
          { id: "file", name: "Updated" },
        ],
        "@odata.deltaLink": checkpoint,
      }),
    ]
    const requests = mockFetch(() => responses.shift()!)
    const client = await connect()
    const pages = await collect(client.drives.delta.pages("d", { top: 10 }))
    expect(pages).toHaveLength(2)
    expect(pages[1].value[0].deleted).toEqual({ state: "deleted" })
    expect(pages[1]["@odata.deltaLink"]).toBe(checkpoint)
    expect(requests[1].url).toBe(next)
    mockFetch((r) => {
      expect(r.url).toBe(checkpoint)
      return json({ value: [], "@odata.deltaLink": checkpoint })
    })
    await client.drives.delta.list("d", { cursor: checkpoint })
  })

  test("latest requests only a checkpoint and 410 requires explicit resynchronization", async () => {
    const checkpoint = `${GRAPH}drives/d/root/delta?token=checkpoint`
    const requests = mockFetch(() => json({ value: [], "@odata.deltaLink": checkpoint }))
    const client = await connect()
    await client.drives.delta.list("d", { token: "latest" })
    expect(new URL(requests[0].url).searchParams.get("token")).toBe("latest")
    const failed = mockFetch(() =>
      apiError(410, "resyncChangesApplyDifferences", { location: checkpoint })
    )
    await expect(
      collect(client.drives.delta.pages("d", { cursor: checkpoint }))
    ).rejects.toMatchObject({
      status: 410,
      code: "resyncChangesApplyDifferences",
      location: checkpoint,
    })
    expect(failed).toHaveLength(1)
  })

  test("ambiguous, missing or hostile checkpoints are rejected", async () => {
    const client = await connect()
    const cursor = `${GRAPH}drives/d/root/delta?token=1`
    for (const extra of [
      {},
      { "@odata.deltaLink": 5 },
      { "@odata.deltaLink": cursor, "@odata.nextLink": cursor },
      { "@odata.deltaLink": "https://attacker.example/token" },
    ]) {
      mockFetch(() => json({ value: [], ...extra }))
      await expect(client.drives.delta.list("d")).rejects.toBeInstanceOf(MicrosoftProtocolError)
    }
    await expect(client.drives.delta.list("d", { cursor, token: "latest" })).rejects.toBeInstanceOf(
      MicrosoftConfigurationError
    )
  })
})
