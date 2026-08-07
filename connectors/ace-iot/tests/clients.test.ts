import { afterEach, describe, expect, test } from "bun:test"
import type { AceIotClientAccount } from "../src"
import { captureFetch, createTestClient, mockFetch, page } from "./helpers"

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

const CLIENT: AceIotClientAccount = {
  id: 1,
  name: "acme",
  nice_name: "Acme Buildings",
  bus_contact: "Ada Lovelace",
  tech_contact: "Grace Hopper",
  address: null,
}

describe("clients", () => {
  test("list and get map to the clients collection", async () => {
    const { urls } = captureFetch(page([CLIENT]))
    const ace = await createTestClient()

    const result = await ace.clients.list({ perPage: 100 })
    await ace.clients.get("acme")

    expect(urls[0].pathname).toBe("/api/clients/")
    expect(urls[0].searchParams.get("per_page")).toBe("100")
    expect(urls[1].pathname).toBe("/api/clients/acme")
    expect(result.items[0]).toEqual(CLIENT)
  })

  test("listSites reads the client's own site collection", async () => {
    const { urls } = captureFetch(page([]))
    const ace = await createTestClient()

    await ace.clients.listSites("acme", { perPage: 10 })

    expect(urls[0].pathname).toBe("/api/clients/acme/sites")
  })

  test("der event listing forwards both filters", async () => {
    const { urls } = captureFetch(page([]))
    const ace = await createTestClient()

    await ace.clients.listDerEvents("acme", {
      perPage: 10,
      getPastEvents: true,
      groupName: "peak-shave",
    })

    expect(urls[0].pathname).toBe("/api/clients/acme/der_events")
    expect(urls[0].searchParams.get("get_past_events")).toBe("true")
    expect(urls[0].searchParams.get("group_name")).toBe("peak-shave")
  })

  test("creating and editing der events use the der_events envelope", async () => {
    const { urls, inits } = captureFetch(undefined)
    const ace = await createTestClient()

    await ace.clients.createDerEvents("acme", [
      {
        title: "Peak shave",
        event_start: "2026-08-08T18:00:00Z",
        event_end: "2026-08-08T20:00:00Z",
      },
    ])
    await ace.clients.updateDerEvents("acme", [{ id: "evt-1", cancelled: true }])

    expect(inits[0].method).toBe("POST")
    expect(JSON.parse(String(inits[0].body))).toEqual({
      der_events: [
        {
          title: "Peak shave",
          event_start: "2026-08-08T18:00:00Z",
          event_end: "2026-08-08T20:00:00Z",
        },
      ],
    })
    expect(inits[1].method).toBe("PUT")
    expect(JSON.parse(String(inits[1].body))).toEqual({
      der_events: [{ id: "evt-1", cancelled: true }],
    })
    expect(urls[1].pathname).toBe("/api/clients/acme/der_events")
  })

  test("the package listing uses ACE's misspelled query parameter", async () => {
    const { urls } = captureFetch(page([]))
    const ace = await createTestClient()

    await ace.clients.listVolttronAgentPackages("acme", { perPage: 10, packageName: "historian" })

    expect(urls[0].pathname).toBe("/api/clients/acme/volttron_agent_package/list")
    // Upstream spells it "voltron", and matching that is the only way the filter works.
    expect(urls[0].searchParams.get("voltron_agent_package_name")).toBe("historian")
  })

  test("downloading a package returns the raw response with its body unread", async () => {
    const urls: URL[] = []
    mockFetch((input) => {
      urls.push(new URL(String(input)))
      return Promise.resolve(
        new Response("wheel-bytes", { headers: { "content-type": "application/octet-stream" } })
      )
    })
    const ace = await createTestClient()

    const response = await ace.clients.downloadVolttronAgentPackage("acme", "pkg-1")

    expect(urls[0].pathname).toBe("/api/clients/acme/volttron_agent_package")
    expect(urls[0].searchParams.get("volttron_agent_package_id")).toBe("pkg-1")
    expect(response.bodyUsed).toBe(false)
    expect(await response.text()).toBe("wheel-bytes")
  })

  test("a failed download throws instead of handing back an error response", async () => {
    mockFetch(async () => new Response("nope", { status: 404 }))
    const ace = await createTestClient({ retry: { maxRetries: 0 } })

    await expect(ace.clients.downloadVolttronAgentPackage("acme", "pkg-1")).rejects.toThrow(
      "failed with 404"
    )
  })

  test("uploading a package sends multipart form data and the name in the query", async () => {
    const { urls, inits } = captureFetch(undefined)
    const ace = await createTestClient()

    await ace.clients.uploadVolttronAgentPackage("acme", {
      file: new File(["wheel"], "historian-1.0.whl"),
      packageName: "historian",
      description: "Forward historian",
    })

    const body = inits[0].body as FormData
    expect(body).toBeInstanceOf(FormData)
    expect((body.get("file") as File).name).toBe("historian-1.0.whl")
    expect(urls[0].searchParams.get("package_name")).toBe("historian")
    expect(urls[0].searchParams.get("description")).toBe("Forward historian")
    // fetch has to set the multipart boundary itself.
    expect(new Headers(inits[0].headers).get("content-type")).toBeNull()
  })

  test("a Blob upload takes the explicit filename", async () => {
    const { inits } = captureFetch(undefined)
    const ace = await createTestClient()

    await ace.clients.uploadVolttronAgentPackage("acme", {
      file: new Blob(["wheel"]),
      packageName: "historian",
      filename: "explicit.whl",
    })

    expect(((inits[0].body as FormData).get("file") as File).name).toBe("explicit.whl")
  })
})
