import { describe, expect, test } from "bun:test"
import {
  type AuthorizationContext,
  can,
  defineGroup,
  defineMarking,
  defineObjectType,
  defineRole,
  link,
  type ObjectQuery,
  OntologyRegistry,
  project,
  prop,
  ref,
  resolveAuthorizationContext,
  SixbHost,
  type UserProfile,
} from "../src"
import { createDelegatedRequestScope } from "../src/execution/scopes"
import {
  collectObjectQueryValidationIssues,
  explainObjectQuery,
  formatObjectQueryExplanation,
  normalizeObjectQuery,
} from "../src/objects/query"
import { withoutUserExpansions } from "../src/objects/query/user-expansions"
import type { QueryObjectsInput } from "../src/storage"
import { createTestSixb } from "../src/testing"
import { createTestRuntimeDeps } from "./test-runtime-deps"

const projectId = "object-query-user-expansion"

const hr = defineMarking("hr")

const Team = defineObjectType({
  id: "Team",
  name: "Team",
  properties: [
    prop("id", "string", { required: true, primary: true }),
    prop("lead", ref.user(), { nullable: true }),
    prop("coach", ref.user(), { nullable: true }),
  ],
  links: [link.self("parent", { cardinality: "one" })],
})

const Task = defineObjectType({
  id: "Task",
  name: "Task",
  properties: [
    prop("id", "string", { required: true, primary: true }),
    prop("title", "string", { required: true }),
    prop("assignee", ref.user(), { nullable: true }),
    prop("reviewers", { type: "array", items: ref.user() }),
    prop("approver", ref.user(), { nullable: true, markings: [hr] }),
    prop("labels", { type: "array", items: "string" }),
  ],
  links: [link("team", Team, { cardinality: "one" })],
})

const members = defineGroup("members")
const directory = defineGroup("directory")
const hrTeam = defineGroup("hr")

const taskReader = defineRole("task-reader", {
  grantedTo: [members, directory, hrTeam],
  grants: [can.view([Task, Team])],
})
const directoryReader = defineRole("directory-reader", {
  grantedTo: [directory, hrTeam],
  grants: [can.view(project.users)],
})
const hrClearance = defineRole("hr-clearance", { grantedTo: [hrTeam], clearances: [hr] })

const ava: UserProfile = {
  id: "usr_ava",
  email: "ava@acme.com",
  displayName: "Ava Martin",
  status: "active",
}
const ben: UserProfile = { id: "usr_ben", email: "ben@acme.com", status: "suspended" }

interface Fixture {
  readonly host: SixbHost
  /** The ids of every `getByIds` call the reader made. */
  readonly lookups: (readonly string[])[]
}

/**
 * Tasks referencing Ava, Ben (suspended after the write) and Gone, whom the directory no longer
 * returns: a write only accepts active members, so the lookup hides Gone afterwards.
 */
async function createFixture(): Promise<Fixture> {
  const host = new SixbHost({
    id: projectId,
    ontology: [Team, Task],
    markings: [hr],
    groups: [members, directory, hrTeam],
    roles: [taskReader, directoryReader, hrClearance],
    ...createTestRuntimeDeps(),
  })
  const users = host.storage.auth?.users
  if (!users) throw new Error("The in-memory storage has no auth store.")

  const people = [
    { id: ava.id, email: ava.email, displayName: ava.displayName },
    { id: ben.id, email: ben.email },
    { id: "usr_gone", email: "gone@acme.com" },
  ]
  for (const [index, person] of people.entries()) {
    await users.create({
      ...person,
      projectId,
      createdAt: new Date(`2026-05-14T10:0${index}:00.000Z`),
    })
  }

  const trusted = createTestSixb(host)
  await trusted.objects(Team).upsert({ properties: { id: "team-1", lead: userRef(ben.id) } })
  await trusted.objects(Task).upsert({
    properties: {
      id: "t1",
      title: "Ship",
      assignee: userRef(ava.id),
      reviewers: [userRef(ben.id), userRef("usr_gone"), userRef(ava.id)],
      approver: userRef(ava.id),
    },
  })
  await trusted.objects(Task).upsert({ properties: { id: "t2", title: "Plan", reviewers: [] } })
  await trusted
    .objects(Task)
    .upsert({ properties: { id: "t3", title: "Hire", assignee: userRef("usr_gone") } })
  await trusted.objects.upsertLink(Task.id, "t1", "team", {
    targetTypeId: Team.id,
    targetId: "team-1",
  })

  await users.updateStatus({ projectId, id: ben.id, status: "suspended" })

  const lookups: (readonly string[])[] = []
  const getByIds = users.getByIds.bind(users)
  users.getByIds = async (params) => {
    lookups.push(params.ids)
    const found = await getByIds(params)
    return found.filter((user) => user.id !== "usr_gone")
  }

  return { host, lookups }
}

function userRef(id: string) {
  return { type: "user" as const, id }
}

function readerIn(host: SixbHost, groupIds: readonly string[]) {
  const context: AuthorizationContext = resolveAuthorizationContext({
    principal: { type: "user", id: `usr_${groupIds.join("_") || "nobody"}` },
    groupIds,
    roles: host.definitions.security.listResolvedRoles(),
  })
  return createTestSixb(host, { authorization: context })
}

const ontology = new OntologyRegistry({ sources: [Team, Task] })
const tasks: ObjectQuery = { kind: "start", objectTypeId: Task.id }

describe("expand() of user properties — authoring", () => {
  test("the builder names user properties on the expand node, at every level", () => {
    const sixb = createTestSixb({
      id: projectId,
      ontology: [Team, Task],
      markings: [hr],
      ...createTestRuntimeDeps(),
    })

    const query = sixb
      .objects(Task)
      .query()
      .expand(Task.p.reviewers)
      .expand(Task.l.team, (team) => team.expand(Team.p.lead))
      .expand(Task.p.assignee)

    expect(query.ir).toEqual({
      kind: "expand",
      input: tasks,
      expansions: [{ linkId: "team", direction: "outgoing", users: ["lead"] }],
      users: ["assignee", "reviewers"],
    })
  })

  test("a user property takes no options", () => {
    const sixb = createTestSixb({
      id: projectId,
      ontology: [Team, Task],
      markings: [hr],
      ...createTestRuntimeDeps(),
    })
    const expand = sixb.objects(Task).query().expand as (
      token: unknown,
      options: unknown
    ) => unknown

    expect(() => expand(Task.p.assignee, { limit: 1 })).toThrow(
      "[Sixb] expand() of a user property takes no options or nested expansions."
    )
  })

  test("normalization dedupes, sorts and merges user properties as expands collapse", () => {
    const query: ObjectQuery = {
      kind: "limit",
      limit: 5,
      input: {
        kind: "expand",
        users: ["reviewers", "assignee"],
        expansions: [{ linkId: "team", direction: "outgoing", users: ["lead"] }],
        input: {
          kind: "expand",
          users: ["assignee"],
          expansions: [{ linkId: "team", direction: "outgoing", users: ["lead", "lead"] }],
          input: tasks,
        },
      },
    }

    expect(normalizeObjectQuery(query)).toEqual({
      kind: "expand",
      input: { kind: "limit", limit: 5, input: tasks },
      expansions: [{ linkId: "team", direction: "outgoing", users: ["lead"] }],
      users: ["assignee", "reviewers"],
    })
  })

  test("two expansions of one link keep the user properties of both", () => {
    // Removal proof: keep only `a.users` in `mergeExpansion` and `coach` is lost.
    const query: ObjectQuery = {
      kind: "expand",
      input: tasks,
      expansions: [
        { linkId: "team", direction: "outgoing", users: ["lead"] },
        { linkId: "team", direction: "outgoing", users: ["coach"] },
      ],
    }

    expect(normalizeObjectQuery(query)).toEqual({
      kind: "expand",
      input: tasks,
      expansions: [{ linkId: "team", direction: "outgoing", users: ["coach", "lead"] }],
    })
  })

  test("explain lists the expanded user properties", () => {
    const explanation = explainObjectQuery(
      {
        kind: "expand",
        input: tasks,
        expansions: [{ linkId: "team", direction: "outgoing", users: ["lead"] }],
        users: ["assignee"],
      },
      { ontology }
    )

    expect(explanation.valid).toBe(true)
    expect(formatObjectQueryExplanation(explanation)).toContain("expand team(@lead), @assignee")
  })
})

describe("expand() of user properties — validation", () => {
  const issues = (query: ObjectQuery) =>
    collectObjectQueryValidationIssues(query, { ontology }).map(({ path, code }) => ({
      path,
      code,
    }))

  test("accepts a ref.user() property and an array of them, top level and nested", () => {
    expect(
      issues({
        kind: "expand",
        input: tasks,
        expansions: [{ linkId: "team", direction: "outgoing", users: ["lead"] }],
        users: ["assignee", "reviewers"],
      })
    ).toEqual([])
  })

  test("rejects properties that are not stored user references", () => {
    const result = collectObjectQueryValidationIssues(
      { kind: "expand", input: tasks, expansions: [], users: ["title", "labels", "missing"] },
      { ontology }
    )

    // Paths index the normalized, sorted list.
    expect(result).toEqual([
      {
        path: "$.users[0]",
        code: "invalid_user_expansion",
        message:
          "Property 'labels' on 'Task' is not a ref.user() property; expand() takes a link or a user property.",
      },
      {
        path: "$.users[1]",
        code: "unknown_property",
        message:
          "Expansion references property 'missing' not present on result type Task (an expand abandoned by a later traverse?)",
      },
      {
        path: "$.users[2]",
        code: "invalid_user_expansion",
        message:
          "Property 'title' on 'Task' is not a ref.user() property; expand() takes a link or a user property.",
      },
    ])
  })

  test("rejects a property that is not a user reference in a nested expansion", () => {
    // Removal proof: drop the `validateUserExpansions` call in `validateExpansion`.
    expect(
      issues({
        kind: "expand",
        input: tasks,
        expansions: [{ linkId: "team", direction: "outgoing", users: ["id"] }],
      })
    ).toEqual([{ path: "$.expansions[0].users[0]", code: "invalid_user_expansion" }])
  })

  test("rejects a user property projected away, including by one operand of a set", () => {
    expect(
      issues({
        kind: "expand",
        input: { kind: "project", input: tasks, properties: ["title"] },
        expansions: [],
        users: ["assignee"],
      })
    ).toEqual([{ path: "$.users[0]", code: "invalid_user_expansion" }])

    // Removal proof: drop the `set` case of `projectedProperties` and the union passes.
    const set = (operand: ObjectQuery): ObjectQuery => ({
      kind: "expand",
      input: { kind: "set", op: "union", inputs: [tasks, operand] },
      expansions: [],
      users: ["assignee"],
    })
    expect(issues(set({ kind: "project", input: tasks, properties: ["id", "title"] }))).toEqual([
      { path: "$.users[0]", code: "invalid_user_expansion" },
    ])
    expect(issues(set({ kind: "project", input: tasks, properties: ["id", "assignee"] }))).toEqual(
      []
    )
  })

  test("rejects user properties under a set operand's expand, at any depth", () => {
    // Removal proof: pass `true` for `usersAllowed` in `validateExpansions` or in the nested call
    // of `validateExpansion`, and a nested case passes, its users silently stripped.
    const operand = (expand: Omit<Extract<ObjectQuery, { kind: "expand" }>, "kind" | "input">) => ({
      kind: "set" as const,
      op: "union" as const,
      inputs: [{ kind: "expand" as const, input: tasks, ...expand }, tasks],
    })

    expect(issues(operand({ expansions: [], users: ["assignee"] }))).toEqual([
      { path: "$.inputs[0].users", code: "invalid_user_expansion" },
    ])
    expect(
      issues(operand({ expansions: [{ linkId: "team", direction: "outgoing", users: ["lead"] }] }))
    ).toEqual([{ path: "$.inputs[0].expansions[0].users", code: "invalid_user_expansion" }])
    expect(
      issues(
        operand({
          expansions: [
            {
              linkId: "team",
              direction: "outgoing",
              expand: [{ linkId: "parent", direction: "outgoing", users: ["lead"] }],
            },
          ],
        })
      )
    ).toEqual([
      { path: "$.inputs[0].expansions[0].expand[0].users", code: "invalid_user_expansion" },
    ])
  })
})

describe("expand() of user properties — execution", () => {
  test("storage receives the query without its user expansions", async () => {
    // Removal proof: return `admitted.query` unstripped from `validateExecutableQuery` and the
    // query needs expand support or a bound, which the in-memory provider refuses.
    const { host } = await createFixture()
    const received: QueryObjectsInput["query"][] = []
    const queryObjects = host.storage.objects.queryObjects?.bind(host.storage.objects)
    if (!queryObjects) throw new Error("The in-memory storage has no query pushdown.")
    host.storage.objects.queryObjects = async (params) => {
      received.push(params.query)
      return queryObjects(params)
    }

    // An expand of user properties alone plans like the plain query: no bound needed.
    const { objects } = await createTestSixb(host)
      .objects(Task)
      .query()
      .expand(Task.p.assignee)
      .list()

    expect(received).toEqual([tasks])
    expect(objects).toHaveLength(3)
  })

  test("removes user expansions at every level, dropping an expand left without a link", () => {
    expect(
      withoutUserExpansions({
        kind: "set",
        op: "union",
        inputs: [
          { kind: "expand", input: tasks, expansions: [], users: ["assignee"] },
          {
            kind: "expand",
            input: tasks,
            expansions: [
              {
                linkId: "team",
                direction: "outgoing",
                users: ["lead"],
                expand: [{ linkId: "parent", direction: "outgoing", users: ["lead"] }],
              },
            ],
            users: ["assignee"],
          },
        ],
      })
    ).toEqual({
      kind: "set",
      op: "union",
      inputs: [
        tasks,
        {
          kind: "expand",
          input: tasks,
          expansions: [
            {
              linkId: "team",
              direction: "outgoing",
              expand: [{ linkId: "parent", direction: "outgoing" }],
            },
          ],
        },
      ],
    })
  })

  test("trusted code gets profiles in one lookup: null when empty or unknown, arrays in order", async () => {
    const { host, lookups } = await createFixture()
    const sixb = createTestSixb(host)

    const { objects } = await sixb
      .objects(Task)
      .query()
      .expand(Task.p.assignee)
      .expand(Task.p.reviewers)
      .expand(Task.l.team, (team) => team.expand(Team.p.lead))
      .limit(10)
      .list()
    const byId = new Map(objects.map((row) => [row.primaryId, row]))

    expect(byId.get("t1")?.users).toEqual({ assignee: ava, reviewers: [ben, ava] })
    expect(byId.get("t1")?.links.team?.users).toEqual({ lead: ben })
    expect(byId.get("t2")?.users).toEqual({ assignee: null, reviewers: [] })
    expect(byId.get("t3")?.users).toEqual({ assignee: null, reviewers: [] })

    // Values stay references: the profile sits next to them.
    expect(byId.get("t1")?.properties.assignee).toEqual(userRef(ava.id))

    expect(lookups).toHaveLength(1)
    expect([...(lookups[0] ?? [])].sort()).toEqual([ava.id, ben.id, "usr_gone"])
  })

  test("a member needs can.view(project.users); without it, entries are omitted", async () => {
    // Removal proof: make `canViewUsers` always true in `#attachUsers` and the member without the
    // grant receives profiles.
    const { host, lookups } = await createFixture()

    const query = (sixb: ReturnType<typeof readerIn>) =>
      sixb
        .objects(Task)
        .query()
        .where((task) => task.p.id.eq("t1"))
        .expand(Task.p.assignee)

    const [withoutGrant] = (await query(readerIn(host, ["members"])).list()).objects
    expect(withoutGrant?.users).toEqual({})
    expect(lookups).toHaveLength(0)

    const [withGrant] = (await query(readerIn(host, ["directory"])).list()).objects
    expect(withGrant?.users).toEqual({ assignee: ava })
  })

  test("a marked property the reader cannot read is never looked up", async () => {
    const { host, lookups } = await createFixture()

    const query = (sixb: ReturnType<typeof readerIn>) =>
      sixb
        .objects(Task)
        .query()
        .where((task) => task.p.id.eq("t1"))
        .expand(Task.p.approver)

    const [uncleared] = (await query(readerIn(host, ["directory"])).list()).objects
    expect(uncleared?.users).toEqual({})
    expect(uncleared?.redactions).toMatchObject({ approver: { reason: "missing_clearance" } })
    expect(lookups).toHaveLength(0)

    const [cleared] = (await query(readerIn(host, ["hr"])).list()).objects
    expect(cleared?.users).toEqual({ approver: ava })
  })

  test("a delegated reader, such as a shared link, never gets profiles", async () => {
    const { host, lookups } = await createFixture()
    const shared = host.withScope(
      createDelegatedRequestScope({
        projectId,
        requestId: "shared-request",
        correlationId: "shared-correlation",
        objectRead: {
          selection: {
            kind: "selected",
            roots: [
              {
                anchor: { objectTypeId: Task.id, primaryId: "t1" },
                node: {
                  objects: [{ objectTypeId: Task.id, propertyIds: ["id", "assignee"] }],
                  links: [],
                },
              },
            ],
          },
          limits: { maxTraversalFacts: 100, maxOutputJsonBytes: 100_000 },
        },
      })
    )

    const result = await shared.objects.executeQuery({
      query: {
        kind: "expand",
        input: { kind: "refs", refs: [{ objectTypeId: Task.id, primaryId: "t1" }] },
        expansions: [],
        users: ["assignee"],
      },
    })

    expect(result.objects[0]?.properties.assignee).toEqual(userRef(ava.id))
    expect(result.objects[0]?.users).toEqual({})
    expect(lookups).toHaveLength(0)
  })

  test("count and exists ignore user expansions", async () => {
    const { host } = await createFixture()
    const query = createTestSixb(host).objects(Task).query().expand(Task.p.assignee)

    expect(await query.count()).toBe(3)
    expect(await query.exists()).toBe(true)
  })
})
