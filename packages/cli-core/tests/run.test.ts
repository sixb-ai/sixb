import { afterEach, describe, expect, test } from "bun:test"
import { createInstanceApiClient, renderInstanceHelp } from "../src"

let server: ReturnType<typeof Bun.serve> | undefined

afterEach(() => {
  server?.stop(true)
  server = undefined
})

describe("instance CLI modes", () => {
  test("the sandbox help names the sandbox's own commands", () => {
    expect(renderInstanceHelp()).toContain("sixb context")
    expect(renderInstanceHelp()).toContain("Check the sandbox and its API access")
  })

  test("local mode sends the configured bearer token", async () => {
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
      kind: "local",
      baseUrl: `http://127.0.0.1:${server.port}`,
      token: "sixb_pat_test.secret",
      profile: "test",
    })

    expect(await client.get("/api/project")).toEqual({ id: "local-project" })
    expect(authorizations).toEqual(["Bearer sixb_pat_test.secret"])
  })

  test("sandbox mode never adds a bearer credential", async () => {
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
      kind: "sandbox",
      baseUrl: `http://127.0.0.1:${server.port}`,
      runContextPath: "/run/sixb/context.json",
    })

    expect(await client.get("/api/project")).toEqual({ id: "sandbox-project" })
    expect(authorizations).toEqual([null])
  })
})
