import { describe, expect, test } from "bun:test"
import {
  type AuthorizationContext,
  AuthorizationError,
  can,
  defineAction,
  defineGroup,
  defineMarking,
  defineObjectType,
  defineRole,
  OntologyValidationError,
  prop,
  ref,
  resolveAuthorizationContext,
  SixbHost,
  userRef,
} from "../src"
import { createTestSixb } from "../src/testing"
import { createTestRuntimeDeps } from "./test-runtime-deps"

const pii = defineMarking("pii")

const Person = defineObjectType({
  id: "Person",
  name: "Person",
  properties: [
    prop("id", "string", { primary: true, required: true }),
    prop("email", "string", { unique: true }),
    prop("badge", "string", { unique: true, markings: [pii] }),
    prop("birthDate", "date", { unique: true }),
    prop("account", ref.user(), { nullable: true, unique: true }),
    prop("name", "string"),
    prop("phone", "string", { markings: [pii] }),
  ],
})

const Employee = defineObjectType({
  id: "Employee",
  name: "Employee",
  extends: Person,
  properties: [],
})

const Secret = defineObjectType({
  id: "Secret",
  name: "Secret",
  properties: [
    prop("id", "string", { primary: true, required: true }),
    prop("code", "string", { unique: true }),
  ],
})

const staff = defineGroup("staff")
const reader = defineRole("person-reader", { grantedTo: [staff], grants: [can.view(Person)] })
const editors = defineGroup("editors")
const editor = defineRole("person-editor", {
  grantedTo: [editors],
  grants: [can.view(Person), can.edit(Person)],
})

const whoHasEmail = defineAction("whoHasEmail")
  .params({ email: { schema: "string", required: true } })
  .writeback(async ({ read, params }) => {
    const holder = await read.objects(Person).getBy(Person.p.email, params.email)
    return { holder: holder?.primaryId ?? null }
  })

let afterLookup: (() => Promise<void>) | null = null
let ensureAttempts = 0

/** Find or create: replayed when a concurrent write creates the holder it found missing. */
const ensurePerson = defineAction("ensurePerson")
  .params({ id: { schema: "string", required: true }, email: { schema: "string", required: true } })
  .edits(async ({ objects, read, params }) => {
    ensureAttempts += 1
    const existing = await read.objects(Person).getBy(Person.p.email, params.email)
    const concurrent = afterLookup
    afterLookup = null
    await concurrent?.()
    if (!existing) objects(Person).create({ id: params.id, email: params.email })
  })

function createHost() {
  return new SixbHost({
    id: "get-by",
    ontology: [Person, Employee, Secret],
    markings: [pii],
    groups: [staff, editors],
    roles: [reader, editor],
    actions: [whoHasEmail, ensurePerson],
    ...createTestRuntimeDeps(),
  })
}

function staffContext(host: SixbHost, groupId = "staff"): AuthorizationContext {
  return resolveAuthorizationContext({
    principal: { type: "user", id: `user-${groupId}` },
    groupIds: [groupId],
    roles: host.definitions.security.listResolvedRoles(),
  })
}

async function seed(host: SixbHost) {
  const sixb = createTestSixb(host)
  await host.storage.auth?.users.create({ projectId: host.id, id: "usr_1", email: "a@x.test" })
  await sixb.objects(Person).upsert({
    properties: {
      id: "ada",
      email: "ada@example.com",
      badge: "B-1",
      birthDate: "1990-01-02",
      account: userRef("usr_1"),
      name: "Ada",
      phone: "+33 1",
    },
  })
  await sixb.objects(Employee).upsert({ properties: { id: "emp", email: "ada@example.com" } })
  return sixb
}

describe("getBy", () => {
  test("finds the object of exactly the type holding a value", async () => {
    const sixb = await seed(createHost())

    expect(await sixb.objects(Person).getBy(Person.p.email, "ada@example.com")).toMatchObject({
      objectTypeId: "Person",
      primaryId: "ada",
    })
    expect(await sixb.objects(Employee).getBy(Employee.p.email, "ada@example.com")).toMatchObject({
      objectTypeId: "Employee",
      primaryId: "emp",
    })
    expect(await sixb.objects(Person).getBy(Person.p.email, "bob@example.com")).toBeNull()
    expect(await sixb.objects(Person).getBy(Person.p.email, "Ada@example.com")).toBeNull()
  })

  test("compares values as writes store them", async () => {
    const sixb = await seed(createHost())

    const byDate = await sixb
      .objects(Person)
      .getBy(Person.p.birthDate, new Date("1990-01-02T15:00:00.000Z"))
    expect(byDate?.primaryId).toBe("ada")
    expect(
      (await sixb.objects(Person).getBy(Person.p.account, { id: "usr_1", type: "user" }))?.primaryId
    ).toBe("ada")
    expect((await sixb.objects.getBy("Person", "email", "ada@example.com"))?.primaryId).toBe("ada")
  })

  test("refuses a property that is not unique, a missing value and an invalid one", async () => {
    const sixb = await seed(createHost())

    await expect(sixb.objects.getBy("Person", "name", "Ada")).rejects.toThrow(
      "[Sixb] Cannot look up 'Person.name' by value: getBy needs a property declared with unique: true."
    )
    await expect(sixb.objects.getBy("Person", "email", null)).rejects.toBeInstanceOf(
      OntologyValidationError
    )
    await expect(sixb.objects.getBy("Person", "email", 42)).rejects.toBeInstanceOf(
      OntologyValidationError
    )
    await expect(
      sixb.objects(Person).getBy(Secret.p.code as never, "x" as never)
    ).rejects.toBeInstanceOf(OntologyValidationError)
  })

  test("needs a view grant on the type and clearance for a marked property", async () => {
    const host = createHost()
    await seed(host)
    const staffReader = createTestSixb(host, { authorization: staffContext(host) })

    const found = await staffReader.objects(Person).getBy(Person.p.email, "ada@example.com")
    expect(found?.properties).not.toHaveProperty("phone")
    expect(found?.redactions).toMatchObject({ phone: { reason: "missing_clearance" } })

    await expect(staffReader.objects(Person).getBy(Person.p.badge, "B-1")).rejects.toThrow(
      new AuthorizationError(
        "clearance:marking:pii",
        "[Sixb] Cannot look up 'Person.badge' by value: it requires clearance for marking 'pii'."
      )
    )
    await expect(staffReader.objects(Secret).getBy(Secret.p.code, "x")).rejects.toBeInstanceOf(
      AuthorizationError
    )
  })

  // Removal proof: drop `checkUniqueValues` from `objects/object/upsert.ts` and `upsert-batch.ts`;
  // the taken badge then fails with object.unique_violation while the free one is written.
  test("a write needs clearance to give a value to a marked unique property", async () => {
    const host = createHost()
    await seed(host)
    await host.storage.auth?.users.create({
      projectId: host.id,
      id: "user-editors",
      email: "e@x.test",
    })
    const staffEditor = createTestSixb(host, { authorization: staffContext(host, "editors") })
    const refusal = new AuthorizationError(
      "clearance:marking:pii",
      "[Sixb] Cannot write a value to 'Person.badge': it is unique and requires clearance for marking 'pii'."
    )

    for (const badge of ["B-1", "B-2"]) {
      await expect(
        staffEditor.objects(Person).upsert({ properties: { id: "bob", badge } })
      ).rejects.toThrow(refusal)
    }

    const results = await staffEditor.objects.upsertBatch("Person", [
      { properties: { id: "bob", badge: "B-1" } },
      { properties: { id: "cleo", badge: "B-2" } },
      { properties: { id: "dan", name: "Dan" } },
    ])
    expect(results.map((result) => (result.ok ? "ok" : result.error))).toEqual([
      refusal,
      refusal,
      "ok",
    ])
    expect(await staffEditor.objects(Person).get("bob")).toBeNull()
  })

  test("reads in an Action", async () => {
    const sixb = await seed(createHost())

    const run = await sixb.actions.request({
      actionId: "whoHasEmail",
      subject: { kind: "none" },
      params: { email: "ada@example.com" },
    })

    expect(run).toMatchObject({ status: "succeeded", writeback: { result: { holder: "ada" } } })
  })

  // Removal proof: drop `assertValuesUnclaimed` from `executeEditTransaction`
  // (`materializer/edits/commit.ts`); the run then fails with `object.unique_violation`.
  test("replays an Action whose lookup found nothing when the holder appears before its commit", async () => {
    const sixb = await seed(createHost())
    ensureAttempts = 0
    afterLookup = async () => {
      await sixb.objects(Person).upsert({ properties: { id: "bob", email: "bob@example.com" } })
    }

    const run = await sixb.actions.request({
      actionId: "ensurePerson",
      subject: { kind: "none" },
      params: { id: "bob-again", email: "bob@example.com" },
    })

    expect(run.status).toBe("succeeded")
    expect(ensureAttempts).toBe(2)
    expect(await sixb.objects(Person).get("bob-again")).toBeNull()
    expect((await sixb.objects(Person).getBy(Person.p.email, "bob@example.com"))?.primaryId).toBe(
      "bob"
    )
  })
})
