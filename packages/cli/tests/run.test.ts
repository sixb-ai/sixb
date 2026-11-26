import { afterEach, describe, expect, test } from "bun:test"
import { createInstanceApiClient, renderInstanceHelp } from "../src"

let server: ReturnType<typeof Bun.serve> | undefined

afterEach(() => {
  server?.stop(true)
  server = undefined
})

describe("instance CLI connections", () => {
  test("the main help lists the unified commands without sandbox-only context", () => {
    expect(renderInstanceHelp()).toContain("sixb status")
    expect(renderInstanceHelp()).toContain("sixb threads")
    expect(renderInstanceHelp()).toContain("sixb memory")
    expect(renderInstanceHelp()).not.toContain("sixb context")
  })

  test("sends the configured bearer token when provided", async () => {
    const authorizations: Array<string | null> = []
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        authorizations.push(request.headers.get("authorization"))
        return Response.json({ id: "local-project" })
      },
    })

    const client = createInstanceApiClient({
      baseUrl: `http://127.0.0.1:${server.port}`,
      token: "sixb_pat_test.secret",
    })

    expect(await client.get("/api/project")).toEqual({ id: "local-project" })
    expect(authorizations).toEqual(["Bearer sixb_pat_test.secret"])
  })

  test("omits authorization when no token is configured", async () => {
    const authorizations: Array<string | null> = []
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        authorizations.push(request.headers.get("authorization"))
        return Response.json({ id: "sandbox-project" })
      },
    })

    const client = createInstanceApiClient({
      baseUrl: `http://127.0.0.1:${server.port}`,
    })

    expect(await client.get("/api/project")).toEqual({ id: "sandbox-project" })
    expect(authorizations).toEqual([null])
  })
})
