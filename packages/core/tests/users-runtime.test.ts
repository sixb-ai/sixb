import { describe, expect, test } from "bun:test"
import { type AuthorizationContext, AuthorizationError, SixbHost, userRef } from "../src"
import { emptyGrantIndex } from "../src/authorization"
import { createDelegatedRequestScope } from "../src/execution/scopes"
import type { Sixb } from "../src/runtime/sixb"
import { createTestSixb } from "../src/testing"
import { createTestRuntimeDeps } from "./test-runtime-deps"

const PROJECT_ID = "users-runtime"

function memberContext(grants: { readonly users?: boolean } = {}): AuthorizationContext {
  return {
    principal: { type: "user", id: "usr_reader" },
    groupIds: [],
    roleIds: [],
    grants: { ...emptyGrantIndex(), "view:users": grants.users ?? false },
  }
}

async function createHost(): Promise<SixbHost> {
  const host = new SixbHost({ id: PROJECT_ID, ontology: [], ...createTestRuntimeDeps() })
  const users = host.storage.auth?.users
  if (!users) throw new Error("The in-memory storage has no auth store.")

  const people = [
    { id: "usr_ava", email: "ava@acme.com", displayName: "Ava Martin", avatarUrl: "https://a/ava" },
    { id: "usr_ben", email: "ben@acme.com", displayName: "Ben Okafor" },
    { id: "usr_cleo", email: "cleo@acme.com", status: "suspended" as const },
  ]
  for (const [index, person] of people.entries()) {
    await users.create({
      ...person,
      projectId: PROJECT_ID,
      createdAt: new Date(`2026-05-14T10:0${index}:00.000Z`),
    })
  }

  return host
}

function ids(page: Awaited<ReturnType<Sixb["users"]["list"]>>): readonly string[] {
  return page.users.map((user) => user.id)
}

describe("sixb.users", () => {
  test("lists active members oldest first, with only their profile fields", async () => {
    const sixb = createTestSixb(await createHost())

    const page = await sixb.users.list()

    expect(page).toEqual({
      users: [
        {
          id: "usr_ava",
          email: "ava@acme.com",
          displayName: "Ava Martin",
          avatarUrl: "https://a/ava",
          status: "active",
        },
        { id: "usr_ben", email: "ben@acme.com", displayName: "Ben Okafor", status: "active" },
      ],
      hasMore: false,
      total: 2,
    })
  })

  test("filters by status and search, and pages", async () => {
    const sixb = createTestSixb(await createHost())

    expect(ids(await sixb.users.list({ status: "suspended" }))).toEqual(["usr_cleo"])
    expect(ids(await sixb.users.list({ status: "all" }))).toEqual([
      "usr_ava",
      "usr_ben",
      "usr_cleo",
    ])
    expect(ids(await sixb.users.list({ search: "  okafor " }))).toEqual(["usr_ben"])
    expect(ids(await sixb.users.list({ search: "   " }))).toEqual(["usr_ava", "usr_ben"])

    const page = await sixb.users.list({ status: "all", limit: 2, offset: 1 })
    expect(ids(page)).toEqual(["usr_ben", "usr_cleo"])
    expect(page).toMatchObject({ hasMore: false, total: 3 })
  })

  test("gets a member by reference, suspended or not", async () => {
    const sixb = createTestSixb(await createHost())

    expect(await sixb.users.get(userRef("usr_cleo"))).toEqual({
      id: "usr_cleo",
      email: "cleo@acme.com",
      status: "suspended",
    })
    expect(await sixb.users.get(userRef("usr_missing"))).toBeNull()
  })

  test("rejects input it cannot read", async () => {
    const sixb = createTestSixb(await createHost())
    const get = sixb.users.get as (user: unknown) => Promise<unknown>

    await expect(get("usr_ava")).rejects.toThrow(
      "[Sixb] users.get expects a user reference, such as userRef(id)."
    )
    for (const limit of [0, 201, 1.5]) {
      await expect(sixb.users.list({ limit })).rejects.toThrow(
        "[Sixb] users.list limit must be an integer from 1 to 200."
      )
    }
    await expect(sixb.users.list({ search: "a".repeat(201) })).rejects.toThrow(
      "[Sixb] users.list search must be at most 200 characters."
    )
    await expect(sixb.users.list({ offset: -1 })).rejects.toThrow(
      "[Sixb] users.list offset must be a non-negative integer."
    )
    await expect(sixb.users.list({ status: "invited" as "all" })).rejects.toThrow(
      '[Sixb] users.list status must be "active", "suspended", or "all".'
    )
  })

  test("a member needs can.view(project.users)", async () => {
    // Removal proof: drop `assertReadable()` from either method and this test fails.
    const host = await createHost()
    const without = createTestSixb(host, { authorization: memberContext() })
    const granted = createTestSixb(host, { authorization: memberContext({ users: true }) })

    await expect(without.users.list()).rejects.toBeInstanceOf(AuthorizationError)
    await expect(without.users.list()).rejects.toThrow(
      "[Sixb] Principal 'usr_reader' is not allowed to view the member directory."
    )
    // Denied before the lookup, so an unknown id reveals nothing either.
    await expect(without.users.get(userRef("usr_missing"))).rejects.toBeInstanceOf(
      AuthorizationError
    )

    expect(ids(await granted.users.list())).toEqual(["usr_ava", "usr_ben"])
    expect(await granted.users.get(userRef("usr_ben"))).toMatchObject({ id: "usr_ben" })
  })

  test("a shared session never reads the directory", async () => {
    const host = await createHost()
    const shared = host.withScope(
      createDelegatedRequestScope({
        projectId: PROJECT_ID,
        requestId: "shared-request",
        correlationId: "shared-correlation",
        objectRead: {
          selection: { kind: "selected", roots: [] },
          limits: { maxTraversalFacts: 10, maxOutputJsonBytes: 1_024 },
        },
        actionApply: [],
      })
    )

    await expect(shared.users.list()).rejects.toBeInstanceOf(AuthorizationError)
    await expect(shared.users.get(userRef("usr_ava"))).rejects.toBeInstanceOf(AuthorizationError)
  })
})
