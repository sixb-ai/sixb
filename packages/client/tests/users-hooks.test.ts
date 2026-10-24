import { describe, expect, test } from "bun:test"
import { getUserQueryKey, listUsersQueryKey } from "../src/generated/@tanstack/react-query.gen"
import { createClient, createConfig } from "../src/generated/client"
import type { ListUsersResponse } from "../src/generated/types.gen"
import { userQueryOptions, usersQueryOptions } from "../src/hooks"

const page: ListUsersResponse = {
  users: [{ id: "usr_ava", email: "ava@acme.com", displayName: "Ava Martin", status: "active" }],
  hasMore: false,
  total: 1,
}

function createUsersTestClient(respond: (path: string) => Response = () => Response.json(page)) {
  const requests: string[] = []
  const client = createClient(
    createConfig({
      baseUrl: "http://sixb.test",
      fetch: (async (request: Request) => {
        const url = new URL(request.url)
        requests.push(`${url.pathname}${url.search}`)
        return respond(url.pathname)
      }) as typeof fetch,
    })
  )
  return { client, requests }
}

type QueryFn<T> = (context: { signal?: AbortSignal }) => Promise<T>

describe("usersQueryOptions", () => {
  test("reads one page of the directory with the given filters", async () => {
    const { client, requests } = createUsersTestClient()

    const options = usersQueryOptions({ client, search: "ava", status: "all", limit: 20 })
    const queryFn = options.queryFn as unknown as (context: {
      signal?: AbortSignal
    }) => Promise<ListUsersResponse>

    expect(await queryFn({})).toEqual(page)
    expect(requests).toEqual(["/api/users?status=all&search=ava&limit=20"])
  })

  test("keys the cache on the filters and passes query options through", () => {
    const options = usersQueryOptions({ search: "ava", staleTime: 60_000, enabled: false })

    expect<unknown>(options.queryKey).toEqual(listUsersQueryKey({ query: { search: "ava" } }))
    expect(options.staleTime).toBe(60_000)
    expect(options.enabled).toBe(false)
  })
})

describe("userQueryOptions", () => {
  const ava = page.users[0]

  test("reads one member by reference or id, and answers null for an unknown one", async () => {
    const { client, requests } = createUsersTestClient((path) =>
      path === "/api/users/usr_ava"
        ? Response.json(ava)
        : Response.json({ error: "[SixbServer] User 'usr_gone' not found." }, { status: 404 })
    )

    const byRef = userQueryOptions({ type: "user", id: "usr_ava" }, { client })
    const byId = userQueryOptions("usr_gone", { client })

    expect(await (byRef.queryFn as unknown as QueryFn<unknown>)({})).toEqual(ava)
    expect(await (byId.queryFn as unknown as QueryFn<unknown>)({})).toBeNull()
    expect(requests).toEqual(["/api/users/usr_ava", "/api/users/usr_gone"])
  })

  // Removal proof: drop the 403 mapping in `userQueryOptions`; the lookup then rejects, so each
  // user chip of the app that mounts asks again.
  test("answers null without access to the directory, and fails on anything else", async () => {
    const answer = (status: number) => {
      const { client } = createUsersTestClient(() =>
        Response.json({ error: "[Sixb] No." }, { status })
      )
      return (userQueryOptions("usr_ava", { client }).queryFn as unknown as QueryFn<unknown>)({})
    }

    expect(await answer(403)).toBeNull()
    await expect(answer(503)).rejects.toBeDefined()
  })

  // Removal proof: key it with `getUserQueryKey`; `getUserOptions` would then read a cached
  // `null` as a member.
  test("keeps its cache apart from the generated getUserOptions", () => {
    const path = { userId: "usr_ava" }

    expect<unknown>(userQueryOptions("usr_ava").queryKey).not.toEqual(getUserQueryKey({ path }))
    expect(userQueryOptions({ type: "user", id: "usr_ava" }).queryKey).toEqual(
      userQueryOptions("usr_ava").queryKey
    )
  })
})
