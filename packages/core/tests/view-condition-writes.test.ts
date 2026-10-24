import { describe, expect, test } from "bun:test"
import {
  type AuthorizationContext,
  can,
  currentUser,
  defineAction,
  defineGroup,
  defineObjectType,
  defineRole,
  link,
  ObjectNotFoundError,
  param,
  prop,
  ref,
  SixbHost,
  userRef,
} from "../src"
import type { ShareAccessPlan } from "../src/shares/access-plan"
import type { ObjectStorage } from "../src/storage"
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
  const reads = countObjectReads(deps.storage.objects)
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
  await trusted.objects(Note).upsert({ properties: { id: "n-alice", owner: userRef(alice.id) } })
  await trusted.objects(Note).upsert({ properties: { id: "n-bob", owner: userRef(bob.id) } })

  const { contextFor } = resolveRolesWithConditions({ ontology, roles })
  const sixbFor = (
    groupIds: readonly string[],
    principal: AuthorizationContext["principal"] = alice
  ) => createTestSixb(host, { authorization: contextFor(groupIds, principal) })

  const stored = (objectTypeId: string, primaryId: string) =>
    host.storage.objects.getByPrimaryId({ projectId, objectTypeId, primaryId })

  return { host, trusted, sixbFor, stored, reads }
}

/**
 * Count the object reads a principal's reader makes, through the store or through the conditional
 * scope it reads a conditioned type through.
 *
 * `answerNextRead` answers the next `getByPrimaryId` on the store in its place: a read made before
 * a concurrent change.
 */
function countObjectReads(objects: ObjectStorage) {
  const counter: { count: number; answerNextRead?: () => unknown } = { count: 0 }
  const counted = <TRead extends (input: never) => unknown>(read: TRead) =>
    ((input: never) => {
      counter.count += 1
      return read(input)
    }) as TRead

  decorateOperationScopedMethodForTesting(objects, "getByPrimaryId", (read) =>
    counted(((input: never) => {
      const answer = counter.answerNextRead
      if (!answer) return read(input)

      counter.answerNextRead = undefined
      return Promise.resolve(answer())
    }) as typeof read)
  )
  decorateOperationScopedMethodForTesting(objects, "getByPrimaryIdBatch", counted)
  decorateOperationScopedMethodForTesting(objects, "createConditionalReadScope", (create) => {
    return (input) => {
      const scope = create(input)
      return {
        ...scope,
        getByPrimaryId: counted(scope.getByPrimaryId.bind(scope)),
        getByPrimaryIdBatch: counted(scope.getByPrimaryIdBatch.bind(scope)),
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
