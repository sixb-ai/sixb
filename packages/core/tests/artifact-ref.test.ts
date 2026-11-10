import { describe, expect, test } from "bun:test"
import {
  artifactRef,
  col,
  defineAction,
  defineDataset,
  defineObjectType,
  defineProjection,
  defineValueType,
  defineWorkflow,
  defineWorkflowStep,
  link,
  OntologyRegistry,
  param,
  prop,
  ref,
  SixbHost,
  valueTypeRef,
} from "../src"
import type { AuthorizationContext } from "../src/authorization"
import { emptyGrantIndex, type GrantIndex } from "../src/authorization/types"
import { bindRequestExecution } from "../src/execution/request"
import { ProjectionRegistry } from "../src/materializer"
import { validateObjectQuery } from "../src/objects/query"
import { isArtifactRef } from "../src/ontology/artifact-ref"
import { schemaRecordToJsonSchema } from "../src/ontology/json-schema"
import { resolvePropertyQueryCapabilities } from "../src/ontology/query-capabilities"
import { normalizeSchemaValue, validateSchemaValue } from "../src/ontology/validation"
import { createTestSixb } from "../src/testing"
import { createTestRuntimeDeps } from "./test-runtime-deps"

const Section = defineValueType({
  id: "Section",
  name: "Section",
  schema: { type: "object", properties: { doc: { schema: ref.artifact() } } },
})

const Meeting = defineObjectType({
  id: "Meeting",
  name: "Meeting",
  properties: [
    prop("id", "string", { primary: true, required: true }),
    prop("title", "string"),
    prop("kickoffDoc", ref.artifact(), {
      nullable: true,
      query: { searchable: true, filterable: true },
    }),
    prop("attachments", { type: "array", items: ref.artifact() }),
    prop("sections", { type: "map", keySchema: "string", valueSchema: valueTypeRef(Section) }),
    prop("status", "string", { query: { searchable: true, filterable: true } }),
  ],
})

const valueTypesById = new Map()
const MISSING = "art_zzzzzzzzzz"

describe("ref.artifact()", () => {
  test("serializes as artifactRef, valued { type: 'artifact', id }", () => {
    expect(ref.artifact()).toBe("artifactRef")
    expect(artifactRef("art_k3m9q2x7tp")).toEqual({ type: "artifact", id: "art_k3m9q2x7tp" })
    expect(Object.isFrozen(artifactRef("art_k3m9q2x7tp"))).toBe(true)

    for (const id of ["", "k3m9q2x7tp", "art_short", "art_K3M9Q2X7TP", "art_k3m9q2x7tpx"]) {
      expect(() => artifactRef(id)).toThrow(
        "[Sixb] Artifact reference id must be an artifact id such as 'art_k3m9q2x7tp'"
      )
    }
  })

  test("accepts exactly { type: 'artifact', id } and stores it in canonical field order", () => {
    validateSchemaValue("artifactRef", artifactRef("art_k3m9q2x7tp"), "Meeting.doc", valueTypesById)

    for (const invalid of [
      "art_k3m9q2x7tp",
      { type: "user", id: "art_k3m9q2x7tp" },
      { type: "artifact", id: "art_short" },
      { type: "artifact", id: "art_k3m9q2x7tp", title: "Spoofed" },
    ]) {
      expect(isArtifactRef(invalid)).toBe(false)
      expect(() =>
        validateSchemaValue("artifactRef", invalid, "Meeting.doc", valueTypesById)
      ).toThrow(
        '[Sixb] Property Meeting.doc must be an artifact reference { type: "artifact", id }'
      )
    }

    const normalized = normalizeSchemaValue(
      "artifactRef",
      { id: "art_k3m9q2x7tp", type: "artifact" },
      "Meeting.doc",
      valueTypesById
    )
    expect(normalized).toEqual({ type: "artifact", id: "art_k3m9q2x7tp" })
    expect(Object.keys(normalized as object)).toEqual(["type", "id"])
  })

  test("describes the value shape to models", () => {
    const output = schemaRecordToJsonSchema({ shape: { doc: "artifactRef" }, valueTypesById })
    expect(output.properties).toEqual({
      doc: {
        type: "object",
        description:
          'A Sixb artifact, written {"type":"artifact","id":"<artifact-id>"}, such as "art_k3m9q2x7tp".',
        properties: {
          type: { type: "string", enum: ["artifact"] },
          id: { type: "string", pattern: "^art_[0-9a-z]{10}$" },
        },
        required: ["type", "id"],
        additionalProperties: false,
      },
    })
  })
})

describe("artifactRef queries", () => {
  const ontology = new OntologyRegistry({ sources: [Meeting] })

  test("match by identity only: no order, facet, text or substring", () => {
    const kickoffDoc = Meeting.properties[2]
    expect(resolvePropertyQueryCapabilities(kickoffDoc, valueTypesById)).toEqual({
      operators: ["eq", "neq", "in", "exists"],
      sortable: false,
      facet: false,
      text: false,
    })

    const validated = validateObjectQuery(
      {
        kind: "filter",
        predicate: { op: "eq", propertyId: "kickoffDoc", value: artifactRef("art_k3m9q2x7tp") },
        input: { kind: "start", objectTypeId: "Meeting" },
      },
      { ontology }
    )
    expect(validated.query).toMatchObject({ predicate: { scalarKind: "artifactRef" } })

    expect(() =>
      validateObjectQuery(
        {
          kind: "filter",
          predicate: { op: "lt", propertyId: "kickoffDoc", value: artifactRef("art_k3m9q2x7tp") },
          input: { kind: "start", objectTypeId: "Meeting" },
        },
        { ontology }
      )
    ).toThrow("Predicate 'lt' cannot be used with property 'kickoffDoc' on 'Meeting'")
  })
})

describe("artifactRef registration", () => {
  const define = (property: ReturnType<typeof prop>) =>
    defineObjectType({
      id: "Holder",
      name: "Holder",
      properties: [prop("id", "string", { primary: true, required: true }), property],
    })

  // Guard: the `facet`, `telemetry` and `unique` traits of `artifactRef` in
  // `ontology/primitives.ts`; turning one on lets its definition register.
  test("keeps artifact references out of facets, telemetry and unique values", () => {
    const registered = (property: ReturnType<typeof prop>) => () =>
      new OntologyRegistry({ sources: [define(property)] })

    expect(
      registered(prop("doc", ref.artifact(), { query: { searchable: true, facet: true } }))
    ).toThrow("facet")
    expect(registered(prop("doc", ref.artifact(), { mode: "telemetry" }))).toThrow(
      "[Sixb] Telemetry property 'doc' on 'Holder' cannot use artifactRef"
    )
    expect(registered(prop("doc", ref.artifact(), { unique: true }))).toThrow(
      "[Sixb] Unique property 'Holder.doc' cannot use artifactRef."
    )
  })

  // Guard: the artifactRef check on link properties in `ontology/validation/properties.ts`.
  test("rejects artifact references on link properties, even nested", () => {
    const Linked = defineObjectType({
      id: "Linked",
      name: "Linked",
      properties: [prop("id", "string", { primary: true, required: true })],
      links: [
        link("meetings", Meeting, {
          properties: [prop("notes", { type: "array", items: ref.artifact() })],
        }),
      ],
    })

    expect(() => new OntologyRegistry({ sources: [Meeting, Linked] })).toThrow(
      "[Sixb] Link property 'Linked.meetings.notes' cannot use ref.artifact(). Artifact references are supported on object properties only."
    )
  })

  // Guard: the artifactRef check in `projections/validation.ts`; without it this mapping registers.
  test("rejects projections that map an artifact reference, even nested in JSON", () => {
    const meetings = defineDataset("meetings", {
      schema: [col("meeting_id", "string"), col("sections", "json")],
    })
    const projection = {
      _tag: "ObjectProjectionDefinition" as const,
      id: "meetings",
      objectTypeId: "Meeting",
      datasetId: "meetings",
      properties: { id: "meeting_id", sections: "sections" },
      links: {},
    }

    expect(
      () =>
        new ProjectionRegistry({
          projections: [projection],
          ontology: new OntologyRegistry({ sources: [Meeting] }),
          datasetsById: new Map([[meetings.id, meetings]]),
        })
    ).toThrow(
      '[Sixb] Projection "meetings": property "Meeting.sections" holds artifact references (ref.artifact()), which a dataset column cannot hold. Set it from an Action or a runtime edit.'
    )

    // Authoring the same mapping does not type-check either.
    defineProjection("typed-meetings", Meeting)
      .fromDataset(meetings)
      // @ts-expect-error artifact references cannot be mapped from a dataset column
      .properties({ id: "meeting_id", sections: "sections" })
  })
})

describe("artifactRef writes", () => {
  const PROJECT = "artifact-ref-test"

  const attachKickoff = defineAction("attachKickoff")
    .on(Meeting)
    .params({ doc: param(ref.artifact()) })
    .edits(({ objects, params, subject }) => {
      objects(Meeting).byId(subject.primaryId).update({ kickoffDoc: params.doc })
    })

  /** Trusted code: it gives the meeting whatever artifact `pinned` names, without asking anyone. */
  let pinned = MISSING
  const pinKickoff = defineAction("pinKickoff")
    .on(Meeting)
    .params({})
    .edits(({ objects, subject }) => {
      objects(Meeting)
        .byId(subject.primaryId)
        .update({ kickoffDoc: artifactRef(pinned) })
    })

  const noopStep = defineWorkflowStep("noop")
    .input({ doc: ref.artifact() })
    .output({})
    .run(async () => ({}))
  const reviewKickoff = defineWorkflow("reviewKickoff")
    .input({ doc: ref.artifact() })
    .then(noopStep)

  async function setup() {
    const deps = createTestRuntimeDeps()
    const host = new SixbHost({
      id: PROJECT,
      ontology: [Meeting],
      actions: [attachKickoff, pinKickoff],
      workflows: [reviewKickoff],
      ...deps,
    })
    const system = createTestSixb(host)
    for (const id of ["usr_alice", "usr_bob", "usr_carol", "usr_gina", "usr_olivia"]) {
      await deps.storage.auth.users.create({ projectId: PROJECT, id, email: `${id}@example.com` })
      await deps.storage.auth.sessions.create({
        id: `session-${id}`,
        projectId: PROJECT,
        userId: id,
        strategyId: "test",
        tokenHash: `hash-${id}`,
        createdAt: new Date("2026-11-09T09:00:00.000Z"),
        expiresAt: new Date("2099-11-09T09:00:00.000Z"),
      })
    }

    /** A member who edits meetings, requests their actions and runs their workflows. */
    const as = (id: string, context: Partial<AuthorizationContext> = {}) =>
      createTestSixb(host, {
        authorization: { ...member(id), ...context },
      })

    /** The same member signed in with a session, the credential conversations share with. */
    const signedIn = (id: string, grants: Partial<GrantIndex> = {}) => {
      const context = member(id)
      return bindRequestExecution(host, {
        request: new Request("http://localhost/test"),
        authorization: {
          type: "principal",
          credential: { type: "session", id: `session-${id}` },
          context: {
            ...context,
            sessionId: `session-${id}`,
            grants: { ...context.grants, "run:agent": true, ...grants },
          },
        },
      })
    }

    /** An artifact `owner` owns: no one else reads it, since nothing shares it. */
    const artifactOf = async (owner: string) => {
      const file = await deps.blobStorage.put({
        body: new TextEncoder().encode("# Kick-off"),
        fileName: "document.md",
        mediaType: "text/markdown",
      })
      const published = await as(owner).artifacts.create({
        kind: "document",
        title: "Kick-off",
        files: [{ path: "document.md", file }],
      })
      return published.artifact.id
    }

    return { host, system, as, signedIn, artifactOf, storage: deps.storage }
  }

  function member(id: string): AuthorizationContext {
    return {
      principal: { type: "user", id },
      groupIds: [],
      roleIds: [],
      grants: {
        ...emptyGrantIndex(),
        "view:object": new Set([Meeting.id]),
        "edit:object": new Set([Meeting.id]),
        "apply:action": new Set([attachKickoff.id, pinKickoff.id]),
        "run:workflow": new Set([reviewKickoff.id]),
      },
    }
  }

  const missing = (path: string, id: string) =>
    `[Sixb] ${path} references artifact '${id}', which does not exist.`

  // Guard: `assertIntroducedArtifactsReachable` in `materializer/edits/operations.ts`.
  test("gives an object only an artifact that exists, however deeply it is nested", async () => {
    const { system, artifactOf } = await setup()
    const doc = await artifactOf("usr_alice")
    const meetings = system.objects(Meeting)

    await meetings.upsert({
      properties: {
        id: "m1",
        kickoffDoc: artifactRef(doc),
        sections: { intro: { doc: artifactRef(doc) } },
      },
    })
    expect((await meetings.get("m1"))?.properties.kickoffDoc).toEqual(artifactRef(doc))

    await expect(
      meetings.upsert({ properties: { id: "m2", kickoffDoc: artifactRef(MISSING) } })
    ).rejects.toThrow(missing("Property 'Meeting.kickoffDoc'", MISSING))
    await expect(
      meetings.upsert({
        properties: { id: "m3", sections: { intro: { doc: artifactRef(MISSING) } } },
      })
    ).rejects.toThrow(missing("Property 'Meeting.sections'", MISSING))
    expect(await meetings.get("m2")).toBeNull()
    expect(await meetings.get("m3")).toBeNull()
  })

  // Guard: the `unchangeableArtifactIds` a principal's upsert passes in `objects/object/upsert.ts`,
  // where the writer sees every meeting; without them Bob's write lands.
  test("refuses an artifact its writer cannot change exactly as a missing one", async () => {
    const { as, artifactOf } = await setup()
    const alicesDoc = await artifactOf("usr_alice")
    const bobsDoc = await artifactOf("usr_bob")
    const bob = as("usr_bob").objects(Meeting)

    await bob.upsert({ properties: { id: "m1", kickoffDoc: artifactRef(bobsDoc) } })

    const unreadable = await bob
      .upsert({ properties: { id: "m2", kickoffDoc: artifactRef(alicesDoc) } })
      .catch((error: unknown) => error)
    const nonexistent = await bob
      .upsert({ properties: { id: "m2", kickoffDoc: artifactRef(MISSING) } })
      .catch((error: unknown) => error)

    expect((unreadable as Error).message).toBe(missing("Property 'Meeting.kickoffDoc'", alicesDoc))
    expect((nonexistent as Error).message).toBe(missing("Property 'Meeting.kickoffDoc'", MISSING))
    expect(Object.getPrototypeOf(unreadable)).toBe(Object.getPrototypeOf(nonexistent))
    expect(await bob.get("m2")).toBeNull()
  })

  // Guard: the `unchangeableArtifactIds` the upsert passes where the writer sees meetings through
  // a view condition (`viewsThroughCondition` in `objects/object/upsert.ts`); without them Gina's
  // write lands, and she then updates Alice's artifact through the meeting.
  test("refuses it the same way to a writer who sees meetings through a condition", async () => {
    const { as, artifactOf } = await setup()
    const alicesDoc = await artifactOf("usr_alice")
    const open = { op: "eq", propertyId: "status", value: "open" } as const
    const gina = as("usr_gina", {
      grants: { ...member("usr_gina").grants, "view:object": new Set() },
      viewConditions: new Map([[Meeting.id, [open]]]),
    }).objects(Meeting)

    const refused = await gina
      .upsert({ properties: { id: "m9", status: "open", kickoffDoc: artifactRef(alicesDoc) } })
      .catch((error: unknown) => error)

    expect((refused as Error).message).toBe(missing("Property 'Meeting.kickoffDoc'", alicesDoc))
    expect(await gina.get("m9")).toBeNull()
  })

  // Guard: `updatableArtifactIds` in `artifacts/execution.ts` keeps only `owner` and `update`;
  // let it keep `read` and Olivia, who only observes the conversation, attaches Alice's plan.
  test("takes an artifact its writer may change, not one they only read", async () => {
    const { storage, as, signedIn, artifactOf } = await setup()
    const plan = await artifactOf("usr_alice")
    await shareInConversation(storage, plan, ["usr_carol"])

    const olivia = signedIn("usr_olivia", { "observe:agentThreads": true })
    expect(await olivia.artifacts.access(plan)).toBe("read")
    const refused = await olivia
      .objects(Meeting)
      .upsert({ properties: { id: "m1", kickoffDoc: artifactRef(plan) } })
      .catch((error: unknown) => error)
    expect((refused as Error).message).toBe(missing("Property 'Meeting.kickoffDoc'", plan))

    // Its owner and a participant of the conversation may change it, and attach it.
    await signedIn("usr_carol")
      .objects(Meeting)
      .upsert({ properties: { id: "m2", kickoffDoc: artifactRef(plan) } })
    await as("usr_alice")
      .objects(Meeting)
      .upsert({ properties: { id: "m3", kickoffDoc: artifactRef(plan) } })
    expect((await as("usr_alice").objects(Meeting).get("m2"))?.properties.kickoffDoc).toEqual(
      artifactRef(plan)
    )
  })

  // Guard: the `unchangeableArtifactIds` of `objects/object/upsert-batch.ts`.
  test("fails only the batch item that names an artifact its writer cannot read", async () => {
    const { as, artifactOf } = await setup()
    const alicesDoc = await artifactOf("usr_alice")
    const bobsDoc = await artifactOf("usr_bob")

    const [readable, unreadable] = await as("usr_bob").objects.upsertBatch("Meeting", [
      { properties: { id: "m1", kickoffDoc: artifactRef(bobsDoc) } },
      { properties: { id: "m2", attachments: [artifactRef(alicesDoc)] } },
    ])

    expect(readable?.ok).toBe(true)
    expect(unreadable?.ok ? null : unreadable?.error.message).toBe(
      missing("Property 'Meeting.attachments'", alicesDoc)
    )
  })

  // Guard: the `held` skip in `materializer/edits/artifact-refs.ts`; without it no one retitles a
  // meeting whose artifact was deleted. Bob reads Alice's artifact through the meeting itself, so
  // a deleted one is what a meeting holds and its writer cannot reach.
  test("keeps what an object already holds, even deleted since", async () => {
    const { as, artifactOf } = await setup()
    const doc = await artifactOf("usr_alice")
    const alice = as("usr_alice")
    await alice.objects(Meeting).upsert({
      properties: { id: "m1", title: "Draft", kickoffDoc: artifactRef(doc) },
    })
    expect(await alice.artifacts.delete(doc)).toBe(true)

    const bob = as("usr_bob").objects(Meeting)
    await bob.upsert({ properties: { id: "m1", title: "Final", kickoffDoc: artifactRef(doc) } })
    expect((await bob.get("m1"))?.properties).toMatchObject({
      title: "Final",
      kickoffDoc: artifactRef(doc),
    })

    // Moving it to another property is a new reference.
    await expect(
      bob.upsert({
        properties: { id: "m1", kickoffDoc: artifactRef(doc), attachments: [artifactRef(doc)] },
      })
    ).rejects.toThrow(missing("Property 'Meeting.attachments'", doc))
  })

  // Guard: `assertParamArtifactsUpdatable` in `actions/request.ts`; without it Bob's run hands
  // Alice's artifact to the trusted edits and succeeds.
  test("checks Action params as their requester, and trusts the Action's own edits", async () => {
    const { system, as, artifactOf } = await setup()
    const alicesDoc = await artifactOf("usr_alice")
    await system.objects(Meeting).upsert({ properties: { id: "m1" } })
    const bob = as("usr_bob").objects(Meeting)

    const refused = await bob
      .requestAction({ id: "m1", action: attachKickoff, params: { doc: artifactRef(alicesDoc) } })
      .catch((error: unknown) => error)
    expect((refused as Error).message).toBe(
      missing("Action param 'Meeting.attachKickoff.doc'", alicesDoc)
    )

    const attached = await as("usr_alice")
      .objects(Meeting)
      .requestAction({ id: "m1", action: attachKickoff, params: { doc: artifactRef(alicesDoc) } })
    expect(attached.status).toBe("succeeded")

    // The Action's edits name an artifact Bob cannot read, and still apply when he asks.
    await system.objects(Meeting).upsert({ properties: { id: "m2" } })
    pinned = alicesDoc
    const pinnedRun = await bob.requestAction({ id: "m2", action: pinKickoff, params: {} })
    expect(pinnedRun.status).toBe("succeeded")
    expect((await bob.get("m2"))?.properties.kickoffDoc).toEqual(artifactRef(alicesDoc))

    // Existence still holds for trusted code.
    pinned = MISSING
    const missingRun = await bob.requestAction({ id: "m2", action: pinKickoff, params: {} })
    expect(missingRun.status).toBe("failed")
    expect((await bob.get("m2"))?.properties.kickoffDoc).toEqual(artifactRef(alicesDoc))
  })

  // Guard: the `updatableArtifacts` that `workflows/request.ts` passes to the dispatcher.
  test("checks Workflow input as its requester", async () => {
    const { as, artifactOf } = await setup()
    const alicesDoc = await artifactOf("usr_alice")

    await expect(
      as("usr_bob").workflows.request(reviewKickoff, { input: { doc: artifactRef(alicesDoc) } })
    ).rejects.toThrow(missing(`Workflow "reviewKickoff" input 'doc'`, alicesDoc))
    await expect(
      as("usr_alice").workflows.request(reviewKickoff, { input: { doc: artifactRef(alicesDoc) } })
    ).resolves.toMatchObject({ created: true })
  })
})

/** Shares the artifact in a conversation of its owner, which these users take part in. */
async function shareInConversation(
  storage: ReturnType<typeof createTestRuntimeDeps>["storage"],
  artifactId: string,
  participants: readonly string[]
) {
  const projectId = "artifact-ref-test"
  const threadId = `thr_${artifactId}`
  const artifact = await storage.artifacts.get({ projectId, id: artifactId })
  const version = await storage.artifacts.getVersion({ projectId, artifactId, version: 1 })
  if (!artifact || !version) throw new Error("Expected the artifact and its first version.")

  await storage.agents.threads.create({ projectId, id: threadId, ownerPrincipal: artifact.owner })
  await storage.agents.threads.addParticipants({
    projectId,
    threadId,
    principals: participants.map((id) => ({ type: "user", id })),
    addedBy: artifact.owner,
    maxParticipants: 50,
  })
  await storage.artifacts.publish({
    projectId,
    artifactId,
    kind: artifact.kind,
    version: { ...version, origin: { threadId, runId: `run_${artifactId}` } },
  })
}
