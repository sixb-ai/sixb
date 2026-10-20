import { describe, expect, test } from "bun:test"
import {
  can,
  currentUser,
  defineAction,
  defineGroup,
  defineObjectType,
  defineRole,
  defineWorkflow,
  defineWorkflowStep,
  link,
  type ObjectQueryPredicate,
  OntologyRegistry,
  param,
  prop,
  ref,
  resolveAuthorizationContext,
  SixbHost,
  userRef,
} from "../src"
import { createAuthorizedObjectReader } from "../src/execution/authorized-object-reader"
import { createDelegatedRequestScope } from "../src/execution/scopes"
import { collectObjectQueryValidationIssues } from "../src/objects/query"
import { bindCurrentUser } from "../src/objects/query/current-user"
import { InMemoryStorage } from "../src/storage/in-memory"
import { createMaterializerTestFixture, createTestSixb } from "../src/testing"
import { createTestRuntimeDeps } from "./test-runtime-deps"

const projectId = "current-user"

const Project = defineObjectType({
  id: "Project",
  name: "Project",
  properties: [prop("id", "string", { primary: true, required: true })],
})

const Task = defineObjectType({
  id: "Task",
  name: "Task",
  properties: [
    prop("id", "string", {
      primary: true,
      required: true,
      query: { searchable: true, sortable: true },
    }),
    prop("title", "string", { query: { searchable: true, filterable: true, exact: true } }),
    prop("assignee", ref.user(), {
      nullable: true,
      query: { searchable: true, filterable: true },
    }),
    prop(
      "reviewers",
      { type: "array", items: ref.user() },
      { query: { searchable: true, filterable: true } }
    ),
  ],
  links: [link("project", Project, { cardinality: "one" })],
})

const me = { type: "currentUser" }

function filtered(predicate: ObjectQueryPredicate) {
  return {
    kind: "filter" as const,
    predicate,
    input: { kind: "start" as const, objectTypeId: Task.id },
  }
}

describe("currentUser() values", () => {
  test("is the frozen wire form { type: 'currentUser' }", () => {
    expect(currentUser()).toEqual({ type: "currentUser" })
    expect(Object.isFrozen(currentUser())).toBe(true)
    expect(JSON.parse(JSON.stringify(currentUser()))).toEqual(me)
  })
})

describe("currentUser() validation", () => {
  const ontology = new OntologyRegistry({ sources: [Project, Task] })
  const codes = (predicate: ObjectQueryPredicate) =>
    collectObjectQueryValidationIssues(filtered(predicate), { ontology }).map((issue) => issue.code)

  test("is accepted where a predicate compares user references", () => {
    expect(codes({ op: "eq", propertyId: "assignee", value: me })).toEqual([])
    expect(codes({ op: "neq", propertyId: "assignee", value: me })).toEqual([])
    expect(codes({ op: "in", propertyId: "assignee", values: [me, null] })).toEqual([])
    expect(codes({ op: "contains", propertyId: "reviewers", value: me })).toEqual([])
  })

  test("is refused on any other property or operator", () => {
    expect(codes({ op: "eq", propertyId: "title", value: me })).toEqual([
      "current_user_requires_user_reference",
    ])
    expect(codes({ op: "contains", propertyId: "assignee", value: me })).toContain(
      "current_user_requires_user_reference"
    )
    expect(codes({ op: "lt", propertyId: "assignee", value: me })).toContain(
      "current_user_operator_not_supported"
    )

    const [issue] = collectObjectQueryValidationIssues(
      filtered({ op: "eq", propertyId: "title", value: me }),
      { ontology }
    )
    expect(issue?.message).toBe(
      "currentUser() can only be compared with a ref.user() property; 'Task.title' is not one."
    )
  })

  test("must be exactly { type: 'currentUser' }", () => {
    expect(
      codes({ op: "eq", propertyId: "assignee", value: { type: "currentUser", id: "usr_1" } })
    ).toEqual(["invalid_predicate_value"])
  })
})

describe("bindCurrentUser", () => {
  const alice = userRef("usr_alice")
  const bob = userRef("usr_bob")
  const bind = (predicate: ObjectQueryPredicate, user?: typeof alice) => {
    const bound = bindCurrentUser(filtered(predicate), user)
    return bound.kind === "filter" ? bound.predicate : undefined
  }
  const presence = (op: "and" | "or", propertyId: string): ObjectQueryPredicate => ({
    op,
    items: [
      { op: "exists", propertyId, value: true },
      { op: "exists", propertyId, value: false },
    ],
  })
  const none = (propertyId: string) => presence("and", propertyId)
  const all = (propertyId: string) => presence("or", propertyId)

  test("substitutes the reading user", () => {
    expect(bind({ op: "eq", propertyId: "assignee", value: me }, alice)).toEqual({
      op: "eq",
      propertyId: "assignee",
      value: alice,
    })
    expect(bind({ op: "in", propertyId: "assignee", values: [me, bob] }, alice)).toEqual({
      op: "in",
      propertyId: "assignee",
      values: [alice, bob],
    })
    expect(
      bind({ op: "not", item: { op: "contains", propertyId: "reviewers", value: me } }, alice)
    ).toEqual({ op: "not", item: { op: "contains", propertyId: "reviewers", value: alice } })
  })

  test("matches no one without a user, and neq matches every row", () => {
    expect(bind({ op: "eq", propertyId: "assignee", value: me })).toEqual(none("assignee"))
    expect(bind({ op: "neq", propertyId: "assignee", value: me })).toEqual(all("assignee"))
    const anyReviewer: ObjectQueryPredicate = {
      op: "contains",
      propertyId: "reviewers",
      value: { type: "user", id: "any" },
    }
    expect(bind({ op: "contains", propertyId: "reviewers", value: me })).toEqual({
      op: "and",
      items: [anyReviewer, { op: "not", item: anyReviewer }],
    })
    expect(bind({ op: "in", propertyId: "assignee", values: [me, bob] })).toEqual({
      op: "in",
      propertyId: "assignee",
      values: [bob],
    })
    expect(bind({ op: "in", propertyId: "assignee", values: [me] })).toEqual(none("assignee"))
  })

  // Guard: `containsNone`. The executor validates parts of a bound query again, as for a vector
  // search, and validation refuses the `exists` pair on a list.
  test("binds to a query that validates again", () => {
    const ontology = new OntologyRegistry({ sources: [Project, Task] })
    for (const predicate of [
      { op: "eq", propertyId: "assignee", value: me },
      { op: "neq", propertyId: "assignee", value: me },
      { op: "in", propertyId: "assignee", values: [me] },
      { op: "contains", propertyId: "reviewers", value: me },
    ] as const) {
      for (const user of [alice, undefined]) {
        const bound = bindCurrentUser(filtered(predicate), user)
        expect(collectObjectQueryValidationIssues(bound, { ontology })).toEqual([])
        expect(bindCurrentUser(bound, user)).toEqual(bound)
      }
    }
  })
})

describe("currentUser() for each reader", () => {
  const members = defineGroup("members")
  const taskReader = defineRole("task-reader", {
    grantedTo: [members],
    grants: [can.view([Task, Project])],
  })

  async function setup() {
    const host = new SixbHost({
      id: projectId,
      ontology: [Project, Task],
      groups: [members],
      roles: [taskReader],
      ...createTestRuntimeDeps(),
    })
    const auth = host.storage.auth
    if (!auth) throw new Error("Test requires auth storage")
    for (const id of ["usr_alice", "usr_bob"]) {
      await auth.users.create({ projectId, id, email: `${id}@example.com` })
    }

    const trusted = createTestSixb(host)
    await trusted.objects(Project).upsert({ properties: { id: "p1" } })
    await trusted.objects(Task).upsert({
      properties: { id: "t1", assignee: userRef("usr_alice"), reviewers: [userRef("usr_bob")] },
    })
    await trusted.objects(Task).upsert({
      properties: { id: "t2", assignee: userRef("usr_bob"), reviewers: [userRef("usr_alice")] },
    })
    await trusted.objects(Task).upsert({ properties: { id: "t3", assignee: null } })
    await trusted.objects.upsertLink(Task.id, "t1", "project", {
      targetTypeId: Project.id,
      targetId: "p1",
    })

    const readerFor = (principal: { type: "user" | "serviceAccount"; id: string }) =>
      createTestSixb(host, {
        authorization: resolveAuthorizationContext({
          principal,
          groupIds: [members.id],
          roles: host.definitions.security.listResolvedRoles(),
        }),
      })

    return {
      alice: readerFor({ type: "user", id: "usr_alice" }),
      serviceAccount: readerFor({ type: "serviceAccount", id: "svc_reports" }),
      unauthenticated: trusted,
    }
  }

  // Guard: the `currentUser` option `#queryExecutorOptions` passes. Without it, every reader
  // matches no one and Alice's assertions fail.
  test("binds the requesting user, and nobody for a service account or without auth", async () => {
    const readers = await setup()

    const assigned = (sixb: (typeof readers)["alice"]) =>
      sixb
        .objects(Task)
        .query()
        .where((task) => task.p.assignee.eq(currentUser()))
        .orderBy(Task.p.id)
        .list()
        .then((result) => result.objects.map((task) => task.primaryId))
    const notAssigned = (sixb: (typeof readers)["alice"]) =>
      sixb
        .objects(Task)
        .query()
        .where((task) => task.p.assignee.neq(currentUser()))
        .count()
    const reviewing = (sixb: (typeof readers)["alice"]) =>
      sixb
        .objects(Task)
        .query()
        .where((task) => task.p.reviewers.contains(currentUser()))
        .exists()
    const projectLinks = async (sixb: (typeof readers)["alice"]) => {
      const result = await sixb.objects.queryLinks({
        query: filtered({ op: "eq", propertyId: "assignee", value: currentUser() }),
      })
      return result.links.map((row) => row.targetId)
    }

    expect(await assigned(readers.alice)).toEqual(["t1"])
    expect(await notAssigned(readers.alice)).toBe(2)
    expect(await reviewing(readers.alice)).toBe(true)
    expect(await projectLinks(readers.alice)).toEqual(["p1"])

    for (const reader of [readers.serviceAccount, readers.unauthenticated]) {
      expect(await assigned(reader)).toEqual([])
      expect(await notAssigned(reader)).toBe(3)
      expect(await reviewing(reader)).toBe(false)
      expect(await projectLinks(reader)).toEqual([])
    }
  })
})

// Guard: a delegated reader has no requester, so `ObjectReaderSecurity` leaves `requestingUser`
// unset. Set it to Alice whatever the authority and `eq` returns t1.
test("a shared link reader matches no one, and neq matches every object", async () => {
  const storage = new InMemoryStorage()
  await storage.auth.users.create({ projectId, id: "usr_alice", email: "usr_alice@example.com" })
  const ontology = new OntologyRegistry({ sources: [Project, Task] })
  await createMaterializerTestFixture({ projectId, ontology, storage }).seed({
    objects: [
      {
        ref: { objectTypeId: Task.id, primaryId: "t1" },
        properties: { id: "t1", assignee: userRef("usr_alice") },
      },
    ],
  })

  const reader = createAuthorizedObjectReader({
    scope: createDelegatedRequestScope({
      projectId,
      requestId: "request-1",
      correlationId: "correlation-1",
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
    }),
    ontology,
    objectStorage: storage.objects,
  })
  const matching = async (op: "eq" | "neq") => {
    const result = await reader.executeQuery({
      query: {
        kind: "filter",
        predicate: { op, propertyId: "assignee", value: currentUser() },
        input: { kind: "refs", refs: [{ objectTypeId: Task.id, primaryId: "t1" }] },
      },
    })
    return result.objects.map((task) => task.primaryId)
  }

  expect(await matching("eq")).toEqual([])
  expect(await matching("neq")).toEqual(["t1"])
})

describe("currentUser() writes", () => {
  const assignTask = defineAction("assignTask")
    .on(Task)
    .params({ assignee: param(ref.user()) })
    .writeback(async () => {})
  const createTask = defineAction("createTask")
    .params({ id: param("string") })
    .edits(({ objects, params }) => {
      objects(Task).create({ id: params.id, assignee: currentUser() as never })
    })
  const noopStep = defineWorkflowStep("noop")
    .input({ assignee: ref.user() })
    .output({})
    .run(async () => ({}))
  const reviewTask = defineWorkflow("reviewTask").input({ assignee: ref.user() }).then(noopStep)

  // Guard: the `isCurrentUser` check in `ontology/validation/schema.ts`, which every write path
  // runs. Without it each write fails with the generic "must be a user reference" message instead.
  test("refuses to store currentUser() on every write path", async () => {
    const failures: unknown[] = []
    const sixb = createTestSixb({
      id: projectId,
      ontology: [Project, Task],
      actions: [assignTask, createTask],
      workflows: [reviewTask],
      onError: (error) => {
        failures.push(error)
      },
      ...createTestRuntimeDeps(),
    })
    const refused = "cannot store currentUser(): it only stands for the user reading"

    await expect(
      sixb.objects(Task).upsert({ properties: { id: "t1", assignee: currentUser() as never } })
    ).rejects.toThrow(refused)

    await expect(
      sixb.actions.request({ actionId: createTask.id, params: { id: "t2" } })
    ).resolves.toMatchObject({ status: "failed" })
    expect(String(failures[0])).toContain(refused)
    expect(await sixb.objects(Task).get("t2")).toBeNull()

    await sixb.objects(Task).upsert({ properties: { id: "t3" } })
    await expect(
      sixb.objects(Task).requestAction({
        id: "t3",
        action: assignTask,
        params: { assignee: currentUser() as never },
      })
    ).rejects.toThrow(refused)

    await expect(
      sixb.workflows.request(reviewTask, { input: { assignee: currentUser() as never } })
    ).rejects.toThrow(refused)
  })
})
