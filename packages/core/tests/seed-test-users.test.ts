import { describe, expect, test } from "bun:test"
import { defineObjectType, prop, ref, SixbHost, userRef } from "../src"
import { createTestSixb, seedTestUsers } from "../src/testing"
import { createTestRuntimeDeps } from "./test-runtime-deps"

const Task = defineObjectType({
  id: "Task",
  name: "Task",
  properties: [
    prop("id", "string", { primary: true, required: true }),
    prop("assignee", ref.user(), { nullable: true }),
  ],
})

function createHost() {
  return new SixbHost({ id: "seed-test-users", ontology: [Task], ...createTestRuntimeDeps() })
}

describe("seedTestUsers", () => {
  test("adds members that writes can reference", async () => {
    const host = createHost()
    const sixb = createTestSixb(host)

    const [zoe, ava] = await seedTestUsers(host, [
      { id: "usr_zoe", email: "Zoe@Acme.com", displayName: "Zoe" },
      { id: "usr_ava", email: "ava@acme.com", status: "suspended" },
    ])

    expect(zoe).toEqual({
      id: "usr_zoe",
      email: "zoe@acme.com",
      displayName: "Zoe",
      status: "active",
    })
    expect(ava).toEqual({ id: "usr_ava", email: "ava@acme.com", status: "suspended" })

    const task = await sixb.objects(Task).upsert({
      properties: { id: "t1", assignee: userRef("usr_zoe") },
    })
    expect(task.properties.assignee).toEqual(userRef("usr_zoe"))
  })

  // Red proof: drop the `createdAt` spacing; both land on one millisecond and sort by id.
  test("keeps the order given in the directory", async () => {
    const host = createHost()
    await seedTestUsers(host, [
      { id: "usr_zoe", email: "zoe@acme.com" },
      { id: "usr_ava", email: "ava@acme.com" },
    ])

    const page = await createTestSixb(host).users.list()
    expect(page.users.map((user) => user.id)).toEqual(["usr_zoe", "usr_ava"])
  })

  test("needs storage with auth", async () => {
    const error = await seedTestUsers({ id: "no-auth", storage: {} }, [
      { id: "usr_ava", email: "ava@acme.com" },
    ]).catch((caught) => caught)

    expect((error as Error).message).toBe(
      "[Sixb] seedTestUsers needs storage with auth, such as InMemoryStorage."
    )
  })
})
