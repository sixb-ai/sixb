import { afterEach, describe, expect, test } from "bun:test"
import { createInstanceApiClient } from "../src"
import { objects } from "../src/commands/objects"

let server: ReturnType<typeof Bun.serve> | undefined

afterEach(() => {
  server?.stop(true)
  server = undefined
})

function serve(respond: () => Response) {
  const requests: { path: string; body: unknown }[] = []
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      requests.push({ path: new URL(request.url).pathname, body: await request.json() })
      return respond()
    },
  })
  const api = createInstanceApiClient({
    kind: "local",
    baseUrl: `http://127.0.0.1:${server.port}`,
    token: "sixb_pat_test.secret",
    profile: "test",
  })
  return { api, requests }
}

async function captureOutput(run: () => Promise<void>): Promise<string> {
  const chunks: string[] = []
  const write = process.stdout.write
  process.stdout.write = ((chunk: string) => {
    chunks.push(String(chunk))
    return true
  }) as typeof process.stdout.write
  try {
    await run()
  } finally {
    process.stdout.write = write
  }
  return chunks.join("")
}

describe("objects get-by", () => {
  test("posts the value as a string, or as JSON with --json", async () => {
    const { api, requests } = serve(() => Response.json({ primaryId: "ada" }))

    const output = await captureOutput(() =>
      objects(api, ["get-by", "Customer", "email", "ada@example.com"])
    )
    await captureOutput(() => objects(api, ["get-by", "Customer", "badge", "42", "--json"]))

    expect(JSON.parse(output)).toEqual({ primaryId: "ada" })
    expect(requests).toEqual([
      { path: "/api/objects/Customer/by/email", body: { value: "ada@example.com" } },
      { path: "/api/objects/Customer/by/badge", body: { value: 42 } },
    ])
  })

  test("prints null when no visible object holds the value", async () => {
    const { api } = serve(() => Response.json({ error: "Object not found" }, { status: 404 }))

    const output = await captureOutput(() =>
      objects(api, ["get-by", "Customer", "email", "nobody@example.com"])
    )

    expect(JSON.parse(output)).toBeNull()
  })

  test("reports other failures", async () => {
    const { api } = serve(() =>
      Response.json({ error: "[Sixb] Cannot look up 'Customer.taxId' by value." }, { status: 403 })
    )

    await expect(objects(api, ["get-by", "Customer", "taxId", "FR-1"])).rejects.toMatchObject({
      body: { status: 403 },
    })
  })
})
