import { describe, expect, test } from "bun:test"
import type { OntologyEditOperation, ProjectionSourceEntry } from "../src/materializer"
import { atomic, createMaterializerFixture, replacement, sourceEntry } from "./materializer-fixture"

/** The fixture's clock: every edit and every publication commits at this instant. */
const WRITTEN_AT = "2026-01-02T03:04:05.000Z"
const READ_BEFORE = "2026-01-02T03:00:00.000Z"
const READ_AFTER = "2026-01-02T04:00:00.000Z"

const ref = (primaryId: string) => ({ objectTypeId: "Device", primaryId })

const create = (id: string, name: string): OntologyEditOperation => ({
  id: `create-${id}`,
  kind: "object.create",
  ref: ref(id),
  properties: { name },
})

function fixture(input: { readonly removeMissing: boolean }) {
  const { materializer, storage } = createMaterializerFixture(input)
  let version = 0

  return {
    edit: (operations: readonly OntologyEditOperation[]) =>
      materializer.edits.commit(atomic(`edit-${++version}`, operations)),

    /** Publishes a full dataset version, read from its source at `sourceReadAt` when known. */
    publish: (values: readonly ProjectionSourceEntry[], sourceReadAt?: string) => {
      version += 1
      return materializer.projections.replace({
        ...replacement(`v${version}`, `2026-02-${String(version).padStart(2, "0")}`, values),
        ...(sourceReadAt ? { sourceReadAt } : {}),
      })
    },

    device: (primaryId: string) =>
      storage.objects.getByPrimaryId({ projectId: "project", ...ref(primaryId) }),

    peers: (primaryId: string) =>
      storage.objects.listLinks({
        projectId: "project",
        objectTypeId: "Device",
        objectId: primaryId,
      }),
  }
}

describe("projections that remove what their dataset misses", () => {
  // Removal proof: return null from `withdrawnCreate` in `replacement-plan.ts`; "acme" and "draft"
  // then stay after the reads that miss them. Drop the read time check there: the read that started
  // before the Actions wrote them removes both.
  test("remove an object an Action created once a dataset read after it misses it", async () => {
    const { edit, publish, device, peers } = fixture({ removeMissing: true })
    await publish([sourceEntry("known", "Known")])
    await edit([
      create("acme", "Acme"),
      create("draft", "Draft"),
      {
        id: "peer",
        kind: "link.upsert",
        ref: { source: ref("acme"), linkId: "peers", target: ref("known") },
      },
    ])

    // The sync started reading before the Actions wrote: it has not caught up yet.
    expect(WRITTEN_AT > READ_BEFORE).toBe(true)
    await publish([sourceEntry("known", "Known")], READ_BEFORE)
    expect(await device("acme")).not.toBeNull()
    expect(await device("draft")).not.toBeNull()

    // A read time nobody can tell decides nothing either.
    await publish([sourceEntry("known", "Known")])
    expect(await device("acme")).not.toBeNull()
    expect(await device("draft")).not.toBeNull()

    // Read after: the dataset holds acme, which stays with the values the Action gave it. It never
    // held draft, which goes.
    const held = await publish(
      [sourceEntry("known", "Known"), sourceEntry("acme", "Acme in the source")],
      READ_AFTER
    )
    expect(held.counts).toMatchObject({ objectsDeleted: 1 })
    expect(await device("draft")).toBeNull()
    expect(await device("acme")).toMatchObject({ properties: { name: "Acme" } })

    // The dataset drops acme: it goes with its link, like any object a projection withdraws.
    const dropped = await publish([sourceEntry("known", "Known")], READ_AFTER)
    expect(dropped.counts).toMatchObject({ objectsDeleted: 1, linksDeleted: 1 })
    expect(dropped.eventCount).toBe(2)
    expect(await device("acme")).toBeNull()
    expect(await peers("known")).toEqual([])

    // Back in the dataset, it comes back with the Action's values and link.
    await publish(
      [sourceEntry("known", "Known"), sourceEntry("acme", "Acme in the source")],
      READ_AFTER
    )
    expect(await device("acme")).toMatchObject({ properties: { name: "Acme" } })
    expect(await peers("acme")).toHaveLength(1)
  })

  test("keep an object the app deleted, even when the dataset holds it again", async () => {
    const { edit, publish, device } = fixture({ removeMissing: true })
    await edit([create("acme", "Acme")])
    await publish([sourceEntry("acme", "Acme")], READ_AFTER)
    await edit([{ id: "delete", kind: "object.delete", ref: ref("acme") }])

    await publish([], READ_AFTER)
    await publish([sourceEntry("acme", "Acme")], READ_AFTER)

    expect(await device("acme")).toBeNull()
  })

  test("keep what Actions created when the projection does not ask", async () => {
    const { edit, publish, device } = fixture({ removeMissing: false })
    await edit([create("acme", "Acme")])

    await publish([], READ_AFTER)

    expect(await device("acme")).toMatchObject({ properties: { name: "Acme" } })
  })
})
