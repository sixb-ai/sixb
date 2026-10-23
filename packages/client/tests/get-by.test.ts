import { describe, expect, test } from "bun:test"
import { defineObjectType, prop } from "@sixb/core"
import { SixbApiError } from "../src/api"
import { createClient, createConfig } from "../src/generated/client"
import { objects } from "../src/query"

const Person = defineObjectType({
  id: "Person",
  name: "Person",
  properties: [
    prop("id", "string", { required: true, primary: true }),
    prop("email", "string", { unique: true }),
    prop("birthDate", "date", { unique: true }),
  ],
})

function createTestClient(response: () => Response) {
  const calls: { url: string; method: string; body: unknown }[] = []
  const client = createClient(
    createConfig({
      baseUrl: "http://sixb.test",
      fetch: (async (request: Request) => {
        calls.push({
          url: new URL(request.url).pathname,
          method: request.method,
          body: await request.json(),
        })
        return response()
      }) as unknown as typeof fetch,
    })
  )
  return { client, calls }
}

const ada = {
  primaryId: "ada",
  objectTypeId: "Person",
  properties: { id: "ada", email: "ada@example.com" },
  createdAt: "2026-01-02T03:04:05.000Z",
  updatedAt: "2026-02-03T04:05:06.000Z",
}

describe("objects().getBy()", () => {
  test("posts the value and revives the object it finds", async () => {
    const { client, calls } = createTestClient(() => Response.json(ada))

    const found = await objects(Person, { client }).getBy(Person.p.email, "ada@example.com")

    expect(calls).toEqual([
      { url: "/api/objects/Person/by/email", method: "POST", body: { value: "ada@example.com" } },
    ])
    expect(found).toMatchObject({ primaryId: "ada", properties: { email: "ada@example.com" } })
    expect(found?.createdAt).toEqual(new Date(ada.createdAt))
  })

  test("sends a date as an ISO string", async () => {
    const { client, calls } = createTestClient(() => Response.json(ada))

    await objects(Person, { client }).getBy(
      Person.p.birthDate,
      new Date("1990-01-02T00:00:00.000Z")
    )

    expect(calls[0]?.body).toEqual({ value: "1990-01-02T00:00:00.000Z" })
  })

  test("resolves null when no object is found", async () => {
    const { client } = createTestClient(() =>
      Response.json({ error: "Object not found" }, { status: 404 })
    )

    expect(await objects(Person, { client }).getBy(Person.p.email, "nobody@example.com")).toBeNull()
  })

  test("rejects a refused lookup and a 404 the route did not answer", async () => {
    const forbidden = createTestClient(() =>
      Response.json({ error: "[Sixb] Cannot look up 'Person.email' by value." }, { status: 403 })
    )
    await expect(
      objects(Person, { client: forbidden.client }).getBy(Person.p.email, "x")
    ).rejects.toMatchObject({ status: 403 })

    const unknownRoute = createTestClient(() => new Response("NOT_FOUND", { status: 404 }))
    await expect(
      objects(Person, { client: unknownRoute.client }).getBy(Person.p.email, "x")
    ).rejects.toBeInstanceOf(SixbApiError)
  })

  test("refuses a token of another object type", async () => {
    const Team = defineObjectType({
      id: "Team",
      name: "Team",
      properties: [
        prop("id", "string", { required: true, primary: true }),
        prop("slug", "string", { unique: true }),
      ],
    })
    const { client, calls } = createTestClient(() => Response.json(ada))

    expect(() => objects(Person, { client }).getBy(Team.p.slug as never, "x" as never)).toThrow(
      "[SixbClient] Property token Team.slug cannot be used with Person."
    )
    expect(calls).toEqual([])
  })

  test("rejects other failures with SixbApiError", async () => {
    const { client } = createTestClient(() =>
      Response.json(
        { error: "[Sixb] Cannot look up 'Person.email' by this value." },
        { status: 400 }
      )
    )

    const refused = await objects(Person, { client })
      .getBy(Person.p.email, "x")
      .catch((error: unknown) => error)

    expect(refused).toBeInstanceOf(SixbApiError)
    expect(refused).toMatchObject({ status: 400, method: "POST" })
  })
})
