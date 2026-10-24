import { describe, expect, test } from "bun:test"
import {
  type AuthorizationContext,
  AuthorizationError,
  can,
  currentUser,
  defineAction,
  defineGroup,
  defineObjectType,
  defineRole,
  type EmbeddingModel,
  link,
  ObjectNotFoundError,
  param,
  prop,
  ref,
  SixbHost,
  userRef,
} from "../src"
import type { ShareAccessPlan } from "../src/shares/access-plan"
import { type InMemoryStorage, objectBatchKey } from "../src/storage"
import { decorateOperationScopedMethodForTesting } from "../src/storage/operation-scope"
import { createTestSixb } from "../src/testing"
import { resolveRolesWithConditions } from "./helpers/view-conditions"
import { createSharedTestScope } from "./shared-test-scope"
import { createTestRuntimeDeps } from "./test-runtime-deps"

// A helpdesk where operators see open tickets only, and everyone sees their own notes. Roles here
// hold conditional view grants, which a host still refuses at startup, so contexts are resolved
// beside the host.

const projectId = "view-condition-writes"
const filterable = { query: { searchable: true, filterable: true } } as const

const Team = defineObjectType({
  id: "team",
  name: "Team",
  properties: [prop("id", "string", { required: true, primary: true })],
})

const Ticket = defineObjectType({
  id: "ticket",
  name: "Ticket",
  properties: [
    prop("id", "string", { required: true, primary: true }),
    prop("status", "string", filterable),
    prop("title", "string"),
  ],
  links: [link("team", Team, { cardinality: "one" })],
})

const Watcher = defineObjectType({
  id: "watcher",
  name: "Watcher",
  properties: [prop("id", "string", { required: true, primary: true })],
  links: [link("watches", Ticket)],
})

const Note = defineObjectType({
  id: "note",
  name: "Note",
  properties: [
    prop("id", "string", { required: true, primary: true }),
    prop("owner", ref.user(), { nullable: true, ...filterable }),
    prop("text", "string"),
  ],
})

const escalate = defineAction("escalate-ticket")
  .on(Ticket)
  .params({})
  .edits(({ objects, subject }) => {
    objects(Ticket).byId(subject.primaryId).update({ title: "escalated" })
  })

// A concurrent write lands while the run's edits run, once: the test sets it.
let duringRetitle: (() => Promise<unknown>) | undefined
const validatedStatuses: unknown[] = []

const retitle = defineAction("retitle-ticket")
  .on(Ticket)
  .params({})
  .validate(({ target }) => {
    validatedStatuses.push(target.properties.status)
  })
  .edits(async ({ objects, subject }) => {
    const during = duringRetitle
    duringRetitle = undefined
    await during?.()

    objects(Ticket).byId(subject.primaryId).update({ title: "retitled" })
  })

const merge = defineAction("merge-ticket")
  .on(Ticket)
  .params({ into: param(ref(Ticket)) })
  .edits(() => {})

const assign = defineAction("assign-ticket")
  .on(Ticket)
  .params({ team: param(ref(Team)) })
  .edits(() => {})

const editNote = defineAction("edit-note")
  .on(Note)
  .params({ text: param("string") })
  .edits(({ objects, subject, params }) => {
    objects(Note).byId(subject.primaryId).update({ text: params.text })
  })

const roles = [
  defineRole("open-tickets", {
    grantedTo: [defineGroup("open")],
    grants: [
      can.view(Ticket).where((ticket) => ticket.p.status.eq("open")),
      can.edit(Ticket),
      can.apply(escalate),
      can.apply(retitle),
      can.apply(merge),
      can.apply(assign),
      can.view(Team),
      can.edit(Team),
      can.view(Watcher),
      can.edit(Watcher),
    ],
  }),
  defineRole("all-tickets", { grantedTo: [defineGroup("all")], grants: [can.view(Ticket)] }),
  defineRole("own-notes", {
    grantedTo: [defineGroup("notes")],
    grants: [
      can.view(Note).where((note) => note.p.owner.eq(currentUser())),
      can.edit(Note),
      can.apply(editNote),
    ],
  }),
]

const alice = { type: "user", id: "usr_alice" } as const
const bob = { type: "user", id: "usr_bob" } as const
const reports = { type: "serviceAccount", id: "svc_reports" } as const

const ontology = [Team, Ticket, Watcher, Note]

async function deploy() {
  const deps = createTestRuntimeDeps()
  const reads = countObjectReads(deps.storage)
  const host = new SixbHost({
    id: projectId,
    ontology,
    actions: [escalate, retitle, merge, assign, editNote],
    onError: () => {},
    ...deps,
  })
  const trusted = createTestSixb(host)

  for (const { id } of [alice, bob]) {
    await deps.storage.auth.users.create({ projectId, id, email: `${id}@example.com` })
  }
  await deps.storage.auth.serviceAccounts.create({ projectId, id: reports.id, name: "Reports" })

  await trusted.objects(Team).upsert({ properties: { id: "team-1" } })
  await trusted.objects(Ticket).upsert({ properties: { id: "t-open", status: "open", title: "a" } })
  await trusted
    .objects(Ticket)
    .upsert({ properties: { id: "t-closed", status: "closed", title: "b" } })
  await trusted.objects(Watcher).upsert({ properties: { id: "watcher-1" } })
  await trusted.objects.upsertLink(Watcher.id, "watcher-1", "watches", {
    targetTypeId: Ticket.id,
    targetId: "t-closed",
  })
  await trusted.objects(Note).upsert({ properties: { id: "n-alice", owner: userRef(alice.id) } })
  await trusted.objects(Note).upsert({ properties: { id: "n-bob", owner: userRef(bob.id) } })

  const { contextFor } = resolveRolesWithConditions({ ontology, roles })
  const sixbFor = (
    groupIds: readonly string[],
    principal: AuthorizationContext["principal"] = alice
  ) => createTestSixb(host, { authorization: contextFor(groupIds, principal) })

  const stored = (objectTypeId: string, primaryId: string) =>
    host.storage.objects.getByPrimaryId({ projectId, objectTypeId, primaryId })

  const watched = async () =>
    (
      await host.storage.objects.listLinks({
        projectId,
        objectTypeId: Watcher.id,
        objectId: "watcher-1",
        linkId: "watches",
      })
    )
      .map((row) => row.targetId)
      .sort()

  return { host, trusted, sixbFor, stored, watched, reads }
}

/**
 * Count the object reads a principal's reader makes, through the store or through the conditional
 * scope it reads a conditioned type through. Reads inside a commit's transaction are the
 * Materializer's own, and are not counted.
 *
 * `answerNextScopedRead` answers the next read through that scope in its place, and `answerNextRead`
 * the next `getByPrimaryId` on the store: a read made before a concurrent change.
 */
function countObjectReads(storage: InMemoryStorage) {
  const counter: {
    count: number
    answerNextScopedRead?: () => unknown
    answerNextRead?: () => unknown
  } = { count: 0 }
  const objects = storage.objects

  let transactions = 0
  const transaction = storage.transaction.bind(storage)
  storage.transaction = async (run, options) => {
    transactions += 1
    try {
      return await transaction(run, options)
    } finally {
      transactions -= 1
    }
  }

  // A batch read the store answers one id at a time counts once.
  let reading = 0
  const counted = <TRead extends (input: never) => Promise<unknown>>(
    read: TRead,
    answers?: "answerNextScopedRead" | "answerNextRead"
  ) =>
    (async (input: never) => {
      if (transactions === 0 && reading === 0) counter.count += 1

      const answer = answers ? counter[answers] : undefined
      if (answers && answer) {
        counter[answers] = undefined
        return answer()
      }

      reading += 1
      try {
        return await read(input)
      } finally {
        reading -= 1
      }
    }) as TRead

  decorateOperationScopedMethodForTesting(objects, "getByPrimaryId", (read) =>
    counted(read, "answerNextRead")
  )
  decorateOperationScopedMethodForTesting(objects, "getByPrimaryIdBatch", (read) => counted(read))
  decorateOperationScopedMethodForTesting(objects, "createConditionalReadScope", (create) => {
    // The scope is a plain object of its own methods.
    return (input) => {
      const scope = create(input)
      return {
        ...scope,
        getByPrimaryId: counted(scope.getByPrimaryId, "answerNextScopedRead"),
        getByPrimaryIdBatch: counted(scope.getByPrimaryIdBatch, "answerNextScopedRead"),
      }
    }
  })

  return counter
}

/** The grant and session a delegated request is recorded under. */
async function seedShare(host: SixbHost, access: ShareAccessPlan): Promise<void> {
  const createdAt = new Date("2026-01-01T00:00:00.000Z")
  const expiresAt = new Date("2099-01-01T00:00:00.000Z")

  await host.storage.shareGrants?.create({
    id: "share-grant",
    projectId,
    definitionId: "ticket-share",
    target: { objectTypeId: Ticket.id, primaryId: "t-closed" },
    issuedBy: alice,
    authoritySnapshot: { version: 1, access },
    tokenHash: "a".repeat(64),
    destinationPath: "/tickets/t-closed",
    createdAt,
    expiresAt,
  })
  await host.storage.shareSessions?.create({
    id: "share-session",
    projectId,
    grantId: "share-grant",
    tokenHash: "b".repeat(64),
    createdAt,
    expiresAt,
    absoluteExpiresAt: expiresAt,
  })
}

const ticket = (primaryId: string) =>
  ({ kind: "object", objectTypeId: Ticket.id, primaryId }) as const

/** What an error tells its caller, with the id it names replaced. */
function outcomeOf(error: unknown, primaryId: string) {
  if (!(error instanceof Error)) return error

  return {
    type: error.constructor,
    name: error.name,
    code: (error as { code?: unknown }).code,
    message: error.message.replaceAll(primaryId, "<id>"),
  }
}

describe("action requests through view conditions", () => {
  // Reproduce: drop the subject from assertNamedObjectsVisible in actions/request.ts, and the
  // operator escalates the closed ticket it cannot see.
  test("a requester acts on a subject it sees, and a hidden one is not found like a missing one", async () => {
    const { host, sixbFor, stored } = await deploy()
    const operator = sixbFor(["open"])

    const run = await operator.actions.request({ actionId: escalate.id, subject: ticket("t-open") })
    expect(run.status).toBe("succeeded")
    expect((await stored(Ticket.id, "t-open"))?.properties.title).toBe("escalated")

    const hidden = await operator.actions
      .request({ actionId: escalate.id, subject: ticket("t-closed"), runId: "act_hidden" })
      .catch((error) => error)
    const missing = await operator.actions
      .request({ actionId: escalate.id, subject: ticket("t-none"), runId: "act_missing" })
      .catch((error) => error)

    expect(hidden).toBeInstanceOf(ObjectNotFoundError)
    expect(hidden.message).toBe("[Sixb] Object not found for action run: ticket:t-closed")
    expect(outcomeOf(hidden, "t-closed")).toEqual(outcomeOf(missing, "t-none"))

    // Nothing is recorded, and the hidden ticket is untouched.
    for (const id of ["act_hidden", "act_missing"]) {
      expect(await host.storage.actionRuns?.getById({ projectId, id })).toBeNull()
    }
    expect((await stored(Ticket.id, "t-closed"))?.properties.title).toBe("b")
  })

  // Reproduce: drop the version comparison from assertRequesterSees in actions/run/context.ts, and
  // the run validates the closed state it loaded, because the reopened one is what Alice sees.
  test("a run whose subject changes between its two reads replays on what it finds then", async () => {
    const { trusted, sixbFor, stored, reads } = await deploy()
    const setStatus = (status: string) =>
      trusted.objects(Ticket).upsert({ properties: { id: "t-open", status } })

    validatedStatuses.length = 0
    const run = await sixbFor(["open"]).actions.request({
      actionId: retitle.id,
      subject: ticket("t-open"),
      // Once requested, the ticket closes, then reopens. The run loads it as it was closed, and
      // Alice reads it reopened: a write landed between the two reads.
      onRequested: async () => {
        await setStatus("closed")
        const closed = await stored(Ticket.id, "t-open")
        await setStatus("open")

        reads.answerNextRead = () => closed
      },
    })

    expect(run.status).toBe("succeeded")
    expect(validatedStatuses).toEqual(["open"])
  })

  // Reproduce: decide canList in actions/execution.ts on view:object alone, and the operator lists
  // none of the actions it may request.
  test("a requester lists the actions on a type it views through a condition", async () => {
    const { sixbFor } = await deploy()
    const operator = sixbFor(["open"])

    expect(operator.actions.list().map((action) => action.id)).toEqual([
      escalate.id,
      retitle.id,
      merge.id,
      assign.id,
    ])
    expect(operator.actions.getById(escalate.id)?.id).toBe(escalate.id)

    // Without the grant to apply it, an action stays unlisted on a type it sees.
    expect(
      sixbFor(["notes"])
        .actions.list()
        .map((action) => action.id)
    ).toEqual([editNote.id])
    expect(sixbFor(["all"]).actions.list()).toEqual([])
  })

  // Reproduce: drop the ref() params from assertNamedObjectsVisible in actions/request.ts, and the
  // operator merges into the closed ticket.
  test("a ref() param of a type viewed through a condition must be visible", async () => {
    const { sixbFor } = await deploy()
    const operator = sixbFor(["open"])
    const mergeInto = (into: string) =>
      operator.actions
        .request({
          actionId: merge.id,
          subject: ticket("t-open"),
          params: { into: { objectTypeId: Ticket.id, primaryId: into } },
        })
        .catch((error) => error)

    expect((await mergeInto("t-open")).status).toBe("succeeded")

    const hidden = await mergeInto("t-closed")
    expect(hidden).toBeInstanceOf(ObjectNotFoundError)
    expect(hidden.message).toBe(
      "[Sixb] Object not found for action param 'ticket.merge-ticket.into': ticket:t-closed"
    )
    expect(outcomeOf(hidden, "t-closed")).toEqual(outcomeOf(await mergeInto("t-none"), "t-none"))

    // A type viewed whole is not looked up, as before conditions: its missing object is accepted.
    const assigned = await operator.actions.request({
      actionId: assign.id,
      subject: ticket("t-open"),
      params: { team: { objectTypeId: Team.id, primaryId: "team-none" } },
    })
    expect(assigned.status).toBe("succeeded")
  })

  // Reproduce: decide run visibility on view:object in assertCallerMayHaveRun, and the operator
  // can no longer replay the run it requested.
  test("a requester reads back the run it requested, and replays its run id", async () => {
    const { sixbFor } = await deploy()
    const operator = sixbFor(["open"])
    const request = { actionId: escalate.id, subject: ticket("t-open"), runId: "act_operator" }

    const run = await operator.actions.request(request)
    expect(run.status).toBe("succeeded")
    expect((await operator.actions.runs.getById(run.id))?.id).toBe(run.id)

    const replayed = await operator.actions.request(request)
    expect(replayed).toEqual(run)
  })

  test("an unconditional grant from another role admits every subject", async () => {
    const { sixbFor } = await deploy()

    const run = await sixbFor(["open", "all"]).actions.request({
      actionId: escalate.id,
      subject: ticket("t-closed"),
    })
    expect(run.status).toBe("succeeded")
  })

  // Reproduce: bind the conditions without the reader's user, and Alice no longer edits her note.
  test("currentUser(): the owner acts on their note, nobody else does", async () => {
    const { sixbFor, stored } = await deploy()
    const request = (principal: AuthorizationContext["principal"]) =>
      sixbFor(["notes"], principal)
        .actions.request({
          actionId: editNote.id,
          subject: { kind: "object", objectTypeId: Note.id, primaryId: "n-alice" },
          params: { text: `by ${principal.id}` },
        })
        .catch((error) => error)

    expect((await request(alice)).status).toBe("succeeded")
    expect(await request(bob)).toBeInstanceOf(ObjectNotFoundError)
    expect(await request(reports)).toBeInstanceOf(ObjectNotFoundError)

    expect((await stored(Note.id, "n-alice"))?.properties.text).toBe("by usr_alice")
  })

  // A share carries its own grants and no condition: the closed ticket it selects is its to act on.
  test("a share admits its delegated request on its own grants", async () => {
    const { host, stored } = await deploy()
    const subject = { objectTypeId: Ticket.id, primaryId: "t-closed" }
    const access = {
      grants: [
        {
          kind: "object.view",
          selection: {
            kind: "selected",
            roots: [
              {
                anchor: subject,
                node: { objects: [{ objectTypeId: Ticket.id, propertyIds: ["id"] }], links: [] },
              },
            ],
          },
        },
        { kind: "action.apply", actionId: escalate.id, subjects: [subject] },
      ],
    } as const
    await seedShare(host, access)

    const shared = host.withScope(
      createSharedTestScope({
        projectId,
        requestId: "shared-request",
        correlationId: "shared-correlation",
        access,
        delegation: { kind: "share", grantId: "share-grant", sessionId: "share-session" },
      })
    )

    const run = await shared.actions.request({
      actionId: escalate.id,
      subject: { kind: "object", ...subject },
    })
    expect(run.status).toBe("succeeded")
    expect((await stored(Ticket.id, "t-closed"))?.properties.title).toBe("escalated")
  })

  // Reproduce: drop assertRequesterSees from loadObjectTarget in actions/run/context.ts, and the
  // run replays on the ticket closed meanwhile: it validates and retitles what Alice cannot see.
  test("a run acts only on a state its requester sees, on a replay too", async () => {
    const { trusted, sixbFor, stored } = await deploy()
    const closeDuringRun = () => {
      duringRetitle = () =>
        trusted.objects(Ticket).upsert({ properties: { id: "t-open", status: "closed" } })
    }

    validatedStatuses.length = 0
    closeDuringRun()
    const run = await sixbFor(["open"]).actions.request({
      actionId: retitle.id,
      subject: ticket("t-open"),
    })

    // The commit conflicted on the close; its replay found the ticket hidden, and failed as on a
    // missing subject.
    const missing = await sixbFor(["open", "all"]).actions.request({
      actionId: retitle.id,
      subject: ticket("t-none"),
    })
    const failure = (failed: typeof run) => ({
      status: failed.status,
      phase: failed.phase,
      code: failed.error?.code,
      message: failed.error?.message,
    })

    expect(run.status).toBe("failed")
    expect(failure(run)).toEqual(failure(missing))
    expect(validatedStatuses).toEqual(["open"])
    expect((await stored(Ticket.id, "t-open"))?.properties).toMatchObject({
      status: "closed",
      title: "a",
    })

    // A requester that views every ticket replays on the closed one, as before conditions.
    await trusted.objects(Ticket).upsert({ properties: { id: "t-open", status: "open" } })
    validatedStatuses.length = 0
    closeDuringRun()
    const whole = await sixbFor(["open", "all"]).actions.request({
      actionId: retitle.id,
      subject: ticket("t-open"),
    })

    expect(whole.status).toBe("succeeded")
    expect(validatedStatuses).toEqual(["open", "closed"])
  })

  // Reproduce: read every named object through the reader in assertNamedObjectsVisible, whatever
  // its type, and the reader of every ticket reads once before its run is recorded.
  test("a requester that views every object reads nothing more before its run is recorded", async () => {
    const { sixbFor, reads } = await deploy()
    const readsBeforeRecording = async (groupIds: readonly string[]) => {
      const before = reads.count
      let counted = -1

      await sixbFor(groupIds).actions.request({
        actionId: merge.id,
        subject: ticket("t-open"),
        params: { into: { objectTypeId: Ticket.id, primaryId: "t-open" } },
        onRequested: () => {
          counted = reads.count - before
        },
      })
      return counted
    }

    // The conditioned requester reads its subject and its param in one batch, which proves the
    // counter sees the reads it would make.
    expect(await readsBeforeRecording(["open"])).toBe(1)
    expect(await readsBeforeRecording(["open", "all"])).toBe(0)
  })
})

describe("direct writes through view conditions", () => {
  test("a writer updates an object it sees, and creates one it then cannot see", async () => {
    const { sixbFor, stored } = await deploy()
    const tickets = sixbFor(["open"]).objects(Ticket)

    const updated = await tickets.upsert({ properties: { id: "t-open", title: "renamed" } })
    expect(updated.properties).toEqual({ id: "t-open", status: "open", title: "renamed" })

    // Nothing is checked after a write. The writer gets the row it sent back, and no longer sees it.
    const created = await tickets.upsert({
      properties: { id: "t-new", status: "closed", title: "new" },
    })
    expect(created.properties).toEqual({ id: "t-new", status: "closed", title: "new" })
    expect(await tickets.get("t-new")).toBeNull()
    expect(await stored(Ticket.id, "t-new")).not.toBeNull()
  })

  // Reproduce: upsert in upsertObject whatever the writer finds, and the operator overwrites the
  // closed ticket.
  test("a create on an id a hidden object holds fails as taken, and leaves that object as it was", async () => {
    const { sixbFor, stored } = await deploy()
    const before = await stored(Ticket.id, "t-closed")

    const taken = await sixbFor(["open"])
      .objects(Ticket)
      .upsert({ properties: { id: "t-closed", title: "overwritten" } })
      .catch((error) => error)

    // The issue's known limit: the writer learns that the id is taken, and nothing else.
    expect(taken).toMatchObject({
      code: "object.unique_violation",
      message: "[Sixb] Another 'ticket' object already has this 'id'.",
      details: { objectTypeId: Ticket.id, propertyId: "id" },
    })
    expect(await stored(Ticket.id, "t-closed")).toEqual(before)

    // A writer that sees every ticket updates it.
    const updated = await sixbFor(["open", "all"])
      .objects(Ticket)
      .upsert({ properties: { id: "t-closed", title: "updated" } })
    expect(updated.properties.title).toBe("updated")
  })

  test("a batch fails a hidden id alone, and writes the rest", async () => {
    const { sixbFor, stored } = await deploy()
    const before = await stored(Ticket.id, "t-closed")

    const results = await sixbFor(["open"]).objects.upsertBatch(Ticket.id, [
      { properties: { id: "t-open", title: "renamed" } },
      { properties: { id: "t-new", status: "closed" } },
      { properties: { id: "t-closed", title: "overwritten" } },
    ])

    expect(results.map((result) => result.ok)).toEqual([true, true, false])
    expect(results[2]).toMatchObject({ error: { code: "object.unique_violation" } })
    expect(await stored(Ticket.id, "t-closed")).toEqual(before)
    expect((await stored(Ticket.id, "t-open"))?.properties.title).toBe("renamed")
  })

  // Reproduce: drop the expected revisions from any object or link write, and the operator writes
  // a ticket that was closed after it read it.
  test("a write expects each object as its writer saw it", async () => {
    const { trusted, sixbFor, stored, watched, reads } = await deploy()
    const objects = sixbFor(["open"]).objects
    const watch = { targetTypeId: Ticket.id, targetId: "t-open" }

    // The operator watches the open ticket, which someone closes between each read of it and the
    // write that follows.
    await objects.upsertLink(Watcher.id, "watcher-1", "watches", watch)
    const seen = await stored(Ticket.id, "t-open")
    await trusted.objects(Ticket).upsert({ properties: { id: "t-open", status: "closed" } })
    const closed = await stored(Ticket.id, "t-open")

    // Each write reads it as it was before, by id or in a batch.
    const batch = new Map([[objectBatchKey(Ticket.id, "t-open"), seen]])
    const writes: [() => Promise<unknown>, unknown][] = [
      [() => objects.upsert(Ticket.id, { id: "t-open", title: "renamed" }), batch],
      [
        () => objects.upsertBatch(Ticket.id, [{ properties: { id: "t-open", title: "renamed" } }]),
        batch,
      ],
      [() => objects(Ticket).byId("t-open").delete(), seen],
      [() => objects.removeLink(Watcher.id, "watcher-1", "watches", watch), batch],
      [() => objects.upsertLink(Watcher.id, "watcher-1", "watches", watch), batch],
      [
        () =>
          objects.upsertLinkBatch([
            { objectTypeId: Watcher.id, sourceId: "watcher-1", linkId: "watches", target: watch },
          ]),
        batch,
      ],
    ]
    for (const [write, readBeforeClosing] of writes) {
      reads.answerNextScopedRead = () => readBeforeClosing
      expect(await write().catch((error) => error)).toMatchObject({ kind: "expectation" })
    }

    expect(await stored(Ticket.id, "t-open")).toEqual(closed)
    expect(await watched()).toEqual(["t-closed", "t-open"])
  })

  // Reproduce: delete in deleteObject without reading the object first, and the operator deletes
  // the closed ticket.
  test("a delete reaches only an object the writer sees", async () => {
    const { sixbFor, stored } = await deploy()
    const tickets = sixbFor(["open"]).objects(Ticket)

    // A hidden object is deleted as a missing one is: not at all.
    expect(await tickets.byId("t-closed").delete()).toBeUndefined()
    expect(await tickets.byId("t-none").delete()).toBeUndefined()
    expect(await stored(Ticket.id, "t-closed")).not.toBeNull()

    await tickets.byId("t-open").delete()
    expect(await stored(Ticket.id, "t-open")).toBeNull()

    // No reader sees a deleted object, so a restore still needs a view of every ticket.
    const restore = await tickets
      .byId("t-open")
      .restore()
      .catch((error) => error)
    expect(restore).toBeInstanceOf(AuthorizationError)
  })

  // Reproduce: read every endpoint from the object storage in loadEndpointExistence, and the
  // operator links the watcher to the closed ticket.
  test("a link needs both of its ends visible: a hidden one is not found, as a missing one is", async () => {
    const { sixbFor } = await deploy()
    const objects = sixbFor(["open"]).objects
    const watch = (targetId: string) =>
      objects
        .upsertLink(Watcher.id, "watcher-1", "watches", { targetTypeId: Ticket.id, targetId })
        .catch((error) => error)
    const assign = (sourceId: string) =>
      objects
        .upsertLink(Ticket.id, sourceId, "team", { targetTypeId: Team.id, targetId: "team-1" })
        .catch((error) => error)

    expect(await watch("t-open")).toBeUndefined()
    expect(await assign("t-open")).toBeUndefined()

    const hiddenTarget = await watch("t-closed")
    expect(hiddenTarget).toBeInstanceOf(ObjectNotFoundError)
    expect(hiddenTarget.message).toBe("[Sixb] Target object not found: ticket:t-closed")
    expect(outcomeOf(hiddenTarget, "t-closed")).toEqual(outcomeOf(await watch("t-none"), "t-none"))

    const hiddenSource = await assign("t-closed")
    expect(hiddenSource.message).toBe("[Sixb] Source object not found: ticket:t-closed")
    expect(outcomeOf(hiddenSource, "t-closed")).toEqual(outcomeOf(await assign("t-none"), "t-none"))

    const [batched] = await objects.upsertLinkBatch([
      {
        objectTypeId: Watcher.id,
        sourceId: "watcher-1",
        linkId: "watches",
        target: { targetTypeId: Ticket.id, targetId: "t-closed" },
      },
    ])
    expect(batched).toMatchObject({ ok: false, error: { name: "ObjectNotFoundError" } })
  })

  // Reproduce: drop the endpoint read from removeLink, and the operator unlinks the closed ticket.
  test("a link to a hidden object is removed as a missing one is: not at all", async () => {
    const { sixbFor, watched } = await deploy()
    const objects = sixbFor(["open"]).objects

    await objects.removeLink(Watcher.id, "watcher-1", "watches", {
      targetTypeId: Ticket.id,
      targetId: "t-closed",
    })
    expect(await watched()).toEqual(["t-closed"])

    await sixbFor(["open", "all"]).objects.removeLink(Watcher.id, "watcher-1", "watches", {
      targetTypeId: Ticket.id,
      targetId: "t-closed",
    })
    expect(await watched()).toEqual([])
  })

  test("currentUser(): a writer edits its own note, and may create one it then cannot see", async () => {
    const { sixbFor, stored } = await deploy()
    const write = (principal: AuthorizationContext["principal"], properties: object) =>
      sixbFor(["notes"], principal)
        .objects.upsert(Note.id, { ...properties })
        .catch((error) => error)

    expect((await write(alice, { id: "n-alice", text: "mine" })).properties.text).toBe("mine")
    expect(await write(bob, { id: "n-alice", text: "bob's" })).toMatchObject({
      code: "object.unique_violation",
    })
    expect(await write(reports, { id: "n-alice", text: "reports" })).toMatchObject({
      code: "object.unique_violation",
    })
    expect((await stored(Note.id, "n-alice"))?.properties.text).toBe("mine")

    // The owner is a value the writer sets: Alice may write a note for Bob, which only he sees.
    const forBob = await write(alice, { id: "n-for-bob", owner: userRef(bob.id), text: "hi" })
    expect(forBob.properties).toEqual({ id: "n-for-bob", owner: userRef(bob.id), text: "hi" })
    expect(await sixbFor(["notes"], alice).objects(Note).get("n-for-bob")).toBeNull()
    expect(await sixbFor(["notes"], bob).objects(Note).get("n-for-bob")).not.toBeNull()
  })

  // Reproduce: require view:object again in objects/vectors/handle.ts, and the operator cannot
  // index the open ticket it sees.
  test("a writer indexes the vectors of an object it sees, and of no other", async () => {
    const embedding: EmbeddingModel = {
      providerId: "test",
      modelId: "embedding-v1",
      definition: { kind: "embedding", providerId: "test", modelId: "embedding-v1", dimensions: 3 },
      embed: async ({ texts }) => ({ vectors: texts.map(() => [1, 0, 0]) }),
    }
    const Article = defineObjectType({
      id: "article",
      name: "Article",
      properties: [
        prop("id", "string", { required: true, primary: true }),
        prop("status", "string", filterable),
        prop("title", "string"),
      ],
      search: { vectors: { content: { source: ["title"], model: embedding } } },
    })
    const editors = defineRole("published-articles", {
      grantedTo: [defineGroup("editors")],
      grants: [
        can.view(Article).where((article) => article.p.status.eq("published")),
        can.edit(Article),
      ],
    })

    const host = new SixbHost({
      id: projectId,
      ontology: [Article],
      models: { embedding: [embedding] },
      ...createTestRuntimeDeps(),
    })
    const trusted = createTestSixb(host)
    await host.storage.auth?.users.create({ projectId, id: alice.id, email: "alice@example.com" })
    await trusted
      .objects(Article)
      .upsert({ properties: { id: "a-published", status: "published", title: "a" } })
    await trusted
      .objects(Article)
      .upsert({ properties: { id: "a-draft", status: "draft", title: "b" } })

    const { contextFor } = resolveRolesWithConditions({ ontology: [Article], roles: [editors] })
    const articles = createTestSixb(host, {
      authorization: contextFor(["editors"], alice),
    }).objects(Article)
    const index = (id: string) =>
      articles
        .byId(id)
        .vector("content")
        .index()
        .catch((error) => error)

    expect(await index("a-published")).toBeUndefined()

    const hidden = await index("a-draft")
    expect(hidden).toBeInstanceOf(AuthorizationError)
    expect(outcomeOf(hidden, "a-draft")).toEqual(outcomeOf(await index("a-none"), "a-none"))
  })

  // Reproduce: take the conditioned branch in upsertObject, deleteObject and loadEndpointExistence
  // for every writer, and the writer of every ticket reads more.
  test("a writer that views every object reads nothing more", async () => {
    const { sixbFor, reads } = await deploy()
    const readsDuring = async (write: () => Promise<unknown>) => {
      const before = reads.count
      await write()
      return reads.count - before
    }

    const operator = sixbFor(["open"]).objects
    expect(
      await readsDuring(() => operator.upsert(Ticket.id, { id: "t-open", title: "x" }))
    ).toBeGreaterThan(0)

    const writer = sixbFor(["open", "all"]).objects
    const closed = { id: "t-closed", title: "x" }

    expect(await readsDuring(() => writer.upsert(Ticket.id, closed))).toBe(0)
    expect(await readsDuring(() => writer.upsertBatch(Ticket.id, [{ properties: closed }]))).toBe(0)
    expect(await readsDuring(() => writer(Ticket).byId("t-closed").delete())).toBe(0)

    // A link reads its two ends from the object storage in one batch, as it always did.
    expect(
      await readsDuring(() =>
        writer.upsertLink(Watcher.id, "watcher-1", "watches", {
          targetTypeId: Ticket.id,
          targetId: "t-open",
        })
      )
    ).toBe(1)
    expect(
      await readsDuring(() =>
        writer.removeLink(Watcher.id, "watcher-1", "watches", {
          targetTypeId: Ticket.id,
          targetId: "t-open",
        })
      )
    ).toBe(0)
  })
})
