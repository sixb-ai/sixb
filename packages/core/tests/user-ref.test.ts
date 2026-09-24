import { describe, expect, test } from "bun:test"
import {
  col,
  defineAction,
  defineDataset,
  defineObjectType,
  defineProjection,
  defineWorkflow,
  defineWorkflowStep,
  link,
  OntologyRegistry,
  param,
  prop,
  ref,
  userRef,
} from "../src"
import { ProjectionRegistry } from "../src/materializer"
import { validateObjectQuery } from "../src/objects/query"
import { schemaRecordToJsonSchema } from "../src/ontology/json-schema"
import { resolvePropertyQueryCapabilities } from "../src/ontology/query-capabilities"
import { normalizeSchemaValue, validateSchemaValue } from "../src/ontology/validation"
import { createTestSixb } from "../src/testing"
import { createTestRuntimeDeps } from "./test-runtime-deps"

const Task = defineObjectType({
  id: "Task",
  name: "Task",
  properties: [
    prop("id", "string", { primary: true, required: true }),
    prop("title", "string"),
    prop("assignee", ref.user(), {
      nullable: true,
      query: { searchable: true, filterable: true, facet: true },
    }),
    prop(
      "reviewers",
      { type: "array", items: ref.user() },
      { query: { searchable: true, filterable: true } }
    ),
  ],
})

const valueTypesById = new Map()

describe("ref namespace", () => {
  test("builds user and file references as their serialized schemas", () => {
    expect(ref.user()).toBe("userRef")
    expect(ref.file()).toBe("fileRef")
    expect(ref(Task)).toEqual({ type: "objectRef", objectTypeId: "Task" })
  })
})

describe("userRef values", () => {
  test("builds a reference from a user id", () => {
    expect(userRef("usr_1")).toEqual({ type: "user", id: "usr_1" })
    expect(() => userRef(" ")).toThrow("[Sixb] User reference id must not be empty.")
  })

  test("accepts exactly { type: 'user', id } and stores it in canonical field order", () => {
    validateSchemaValue("userRef", { type: "user", id: "usr_1" }, "Task.assignee", valueTypesById)
    for (const invalid of [
      "usr_1",
      { type: "serviceAccount", id: "sa_1" },
      { type: "user", id: "" },
      { type: "user", id: "usr_1", displayName: "Spoofed" },
    ]) {
      expect(() =>
        validateSchemaValue("userRef", invalid, "Task.assignee", valueTypesById)
      ).toThrow('[Sixb] Property Task.assignee must be a user reference { type: "user", id }')
    }

    const normalized = normalizeSchemaValue(
      "userRef",
      { id: "usr_1", type: "user" },
      "Task.assignee",
      valueTypesById
    )
    expect(normalized).toEqual({ type: "user", id: "usr_1" })
    expect(Object.keys(normalized as object)).toEqual(["type", "id"])
  })

  test("describes the value shape to models", () => {
    const output = schemaRecordToJsonSchema({ shape: { assignee: "userRef" }, valueTypesById })
    expect(output.properties).toEqual({
      assignee: {
        type: "object",
        properties: {
          type: { type: "string", enum: ["user"] },
          id: { type: "string", minLength: 1 },
        },
        required: ["type", "id"],
        additionalProperties: false,
      },
    })
  })
})

describe("userRef query traits", () => {
  const ontology = new OntologyRegistry({ sources: [Task] })

  test("matches by identity and facets, but never sorts or searches text", () => {
    const [, , assignee, reviewers] = Task.properties
    expect(resolvePropertyQueryCapabilities(assignee, valueTypesById)).toEqual({
      operators: ["eq", "neq", "in", "exists"],
      sortable: false,
      facet: true,
      text: false,
    })
    expect(resolvePropertyQueryCapabilities(reviewers, valueTypesById).operators).toEqual([
      "contains",
    ])

    const validated = validateObjectQuery(
      {
        kind: "filter",
        predicate: {
          op: "contains",
          propertyId: "reviewers",
          value: { type: "user", id: "usr_1" },
        },
        input: { kind: "start", objectTypeId: "Task" },
      },
      { ontology }
    )
    expect(validated.query).toMatchObject({ predicate: { scalarKind: "userRef" } })

    for (const predicate of [
      { op: "lt", propertyId: "assignee", value: { type: "user", id: "usr_1" } },
      { op: "contains", propertyId: "assignee", value: "usr" },
    ] as const) {
      expect(() =>
        validateObjectQuery(
          { kind: "filter", predicate, input: { kind: "start", objectTypeId: "Task" } },
          { ontology }
        )
      ).toThrow(`Predicate '${predicate.op}' cannot be used with property 'assignee' on 'Task'`)
    }
  })
})

describe("userRef registration", () => {
  // Guard: `exactSearch: false` in the traits table; with it `true`, both definitions register.
  test("keeps user references out of the exact-match search profile", () => {
    const withExactFlag = defineObjectType({
      id: "ExactTask",
      name: "Exact task",
      properties: [
        prop("id", "string", { primary: true, required: true }),
        prop("assignee", ref.user(), {
          query: { searchable: true, filterable: true, exact: true },
        }),
      ],
    })
    expect(() => new OntologyRegistry({ sources: [withExactFlag] })).toThrow(
      "[Sixb] Query metadata for property 'assignee' on 'ExactTask' enables exact search, but its schema cannot be exact-matched"
    )

    const inSearchProfile = defineObjectType({
      id: "ProfileTask",
      name: "Profile task",
      properties: [
        prop("id", "string", { primary: true, required: true }),
        prop("assignee", ref.user(), { query: { searchable: true, filterable: true } }),
      ],
      search: { exact: ["assignee"] },
    })
    expect(() => new OntologyRegistry({ sources: [inSearchProfile] })).toThrow("search.exact")
  })

  test("rejects ref(ObjectType) on an object property and points to link()", () => {
    const Customer = defineObjectType({
      id: "Customer",
      name: "Customer",
      properties: [prop("id", "string", { primary: true, required: true })],
    })
    const Order = defineObjectType({
      id: "Order",
      name: "Order",
      properties: [
        prop("id", "string", { primary: true, required: true }),
        prop("customer", ref(Customer) as never),
      ],
    })

    expect(() => new OntologyRegistry({ sources: [Customer, Order] })).toThrow(
      `[Sixb] Property 'Order.customer' uses ref(ObjectType), which is only for Action and Workflow parameters. Point to another object with link("customer", ObjectType) instead.`
    )
  })

  test("rejects user references in telemetry and link properties", () => {
    const Telemetry = defineObjectType({
      id: "Telemetry",
      name: "Telemetry",
      properties: [
        prop("id", "string", { primary: true, required: true }),
        prop("operator", ref.user(), { mode: "telemetry" }),
      ],
    })
    expect(() => new OntologyRegistry({ sources: [Telemetry] })).toThrow(
      "[Sixb] Telemetry property 'operator' on 'Telemetry' cannot use userRef"
    )

    const Linked = defineObjectType({
      id: "Linked",
      name: "Linked",
      properties: [prop("id", "string", { primary: true, required: true })],
      links: [link("tasks", Task, { properties: [prop("reviewer", ref.user())] })],
    })
    expect(() => new OntologyRegistry({ sources: [Task, Linked] })).toThrow(
      "[Sixb] Link property 'Linked.tasks.reviewer' cannot use ref.user()"
    )
  })

  // Guard: the userRef check in `projections/validation.ts`; without it this mapping registers.
  test("rejects projections that map a user reference, even nested in JSON", () => {
    const tasks = defineDataset("tasks", {
      schema: [col("task_id", "string"), col("reviewer_ids", "json")],
    })
    const projection = {
      _tag: "ObjectProjectionDefinition" as const,
      id: "tasks",
      objectTypeId: "Task",
      datasetId: "tasks",
      properties: { id: "task_id", reviewers: "reviewer_ids" },
      links: {},
    }

    expect(
      () =>
        new ProjectionRegistry({
          projections: [projection],
          ontology: new OntologyRegistry({ sources: [Task] }),
          datasetsById: new Map([[tasks.id, tasks]]),
        })
    ).toThrow(
      '[Sixb] Projection "tasks": property "Task.reviewers" holds user references (ref.user()), which projections cannot map yet.'
    )
    // Authoring the same mapping does not type-check either.
    defineProjection("typed-tasks", Task)
      .fromDataset(tasks)
      // @ts-expect-error user references cannot be mapped from a dataset column
      .properties({ id: "task_id", reviewers: "reviewer_ids" })
  })
})

describe("userRef writes", () => {
  const assignTask = defineAction("assignTask")
    .on(Task)
    .params({ assignee: param(ref.user()) })
    .writeback(async () => {})
  const noopStep = defineWorkflowStep("noop")
    .input({ assignee: ref.user() })
    .output({})
    .run(async () => ({}))
  const reviewTask = defineWorkflow("reviewTask").input({ assignee: ref.user() }).then(noopStep)

  async function setup() {
    const deps = createTestRuntimeDeps()
    const sixb = createTestSixb({
      id: "user-ref-test",
      ontology: [Task],
      actions: [assignTask],
      workflows: [reviewTask],
      ...deps,
    })
    const users = deps.storage.auth.users
    for (const id of ["usr_active", "usr_suspended"]) {
      await users.create({ projectId: "user-ref-test", id, email: `${id}@example.com` })
    }
    return { sixb, users }
  }

  // Guard: `assertIntroducedUsersActive` in `materializer/edits/operations.ts`.
  test("accepts active users and rejects unknown or suspended ones", async () => {
    const { sixb, users } = await setup()
    await users.updateStatus({
      projectId: "user-ref-test",
      id: "usr_suspended",
      status: "suspended",
    })
    const tasks = sixb.objects(Task)

    await tasks.upsert({
      properties: { id: "t1", assignee: userRef("usr_active"), reviewers: [userRef("usr_active")] },
    })
    await expect(
      tasks.upsert({ properties: { id: "t2", assignee: userRef("usr_missing") } })
    ).rejects.toThrow(
      "[Sixb] Property 'Task.assignee' references user 'usr_missing', which does not exist."
    )
    await expect(
      tasks.upsert({ properties: { id: "t3", reviewers: [userRef("usr_suspended")] } })
    ).rejects.toThrow(
      "[Sixb] Property 'Task.reviewers' references user 'usr_suspended', who is suspended."
    )
    expect(await tasks.get("t2")).toBeNull()
    expect(await tasks.get("t3")).toBeNull()
  })

  // Guard: the `held` skip in `materializer/edits/user-refs.ts`; removing it re-validates
  // unchanged values and the second upsert fails.
  test("keeps existing references writable after the user is suspended", async () => {
    const { sixb, users } = await setup()
    const tasks = sixb.objects(Task)
    await tasks.upsert({
      properties: { id: "t1", title: "Draft", assignee: userRef("usr_suspended") },
    })
    await users.updateStatus({
      projectId: "user-ref-test",
      id: "usr_suspended",
      status: "suspended",
    })

    await tasks.upsert({
      properties: { id: "t1", title: "Final", assignee: userRef("usr_suspended") },
    })
    expect((await tasks.get("t1"))?.properties).toMatchObject({
      title: "Final",
      assignee: userRef("usr_suspended"),
    })
    // Moving the same user to another property is a new reference.
    await expect(
      tasks.upsert({
        properties: {
          id: "t1",
          assignee: userRef("usr_suspended"),
          reviewers: [userRef("usr_suspended")],
        },
      })
    ).rejects.toThrow(
      "Property 'Task.reviewers' references user 'usr_suspended', who is suspended."
    )
  })

  // Guard: `assertParamUsersActive` in the Action and Workflow run dispatchers.
  test("checks user references in Action params and Workflow input of new runs", async () => {
    const { sixb } = await setup()

    await expect(
      sixb.objects(Task).requestAction({
        id: "t1",
        action: assignTask,
        params: { assignee: userRef("usr_active") },
      })
    ).resolves.toMatchObject({ created: true })
    await expect(
      sixb.objects(Task).requestAction({
        id: "t1",
        action: assignTask,
        params: { assignee: userRef("usr_missing") },
      })
    ).rejects.toThrow(
      "[Sixb] Action param 'Task.assignTask.assignee' references user 'usr_missing', which does not exist."
    )

    await expect(
      sixb.workflows.request(reviewTask, { input: { assignee: userRef("usr_active") } })
    ).resolves.toMatchObject({ created: true })
    await expect(
      sixb.workflows.request(reviewTask, { input: { assignee: userRef("usr_missing") } })
    ).rejects.toThrow(
      `[Sixb] Workflow "reviewTask" input 'assignee' references user 'usr_missing', which does not exist.`
    )
  })
})
