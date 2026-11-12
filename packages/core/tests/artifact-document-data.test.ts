import { describe, expect, test } from "bun:test"
import type { ArtifactFile, AuthorizationContext } from "../src"
import { artifactRef, defineObjectType, link, prop, ref, SixbHost } from "../src"
import { emptyGrantIndex } from "../src/authorization/types"
import { createTestSixb } from "../src/testing"
import { createTestRuntimeDeps } from "./test-runtime-deps"

// A designed document shows live data of the object that holds it, of the type its
// <meta name="sixb:object-type"> names, and of its queries, which may start from that object. Each
// reader reads them with their own rights; publishing checks its fields against them.

const projectId = "document-data"

const Organization = defineObjectType({
  id: "Organization",
  name: "Organization",
  properties: [prop("id", "string", { primary: true, required: true }), prop("name", "string")],
})

const Contract = defineObjectType({
  id: "Contract",
  name: "Contract",
  properties: [
    prop("id", "string", { primary: true, required: true }),
    prop("number", "string"),
    prop("document", ref.artifact(), { nullable: true }),
  ],
  links: [link("client", Organization, { cardinality: "one" })],
})

function setup() {
  const deps = createTestRuntimeDeps()
  const host = new SixbHost({ id: projectId, ontology: [Organization, Contract], ...deps })
  const as = (id: string, views: readonly string[] = ["Contract", "Organization"]) => {
    const authorization: AuthorizationContext = {
      principal: { type: "user", id },
      groupIds: [],
      roleIds: [],
      grants: { ...emptyGrantIndex(), "view:object": new Set(views) },
    }
    return createTestSixb(host, { authorization })
  }
  const put = async (path: string, body: string): Promise<ArtifactFile> => ({
    path,
    file: await deps.blobStorage.put({ body: new TextEncoder().encode(body), fileName: path }),
  })
  /** A proposal of a Contract: its fields, and its queries by name. */
  const proposal = async (
    body: string,
    queries: Record<string, unknown> = {},
    head = '<meta name="sixb:object-type" content="Contract">'
  ) => ({
    kind: "document" as const,
    title: "Proposal",
    files: [
      await put(
        "document.html",
        `<!doctype html><html lang="en"><head>${head}</head><body>${body}</body></html>`
      ),
      ...(await Promise.all(
        Object.entries(queries).map(([name, query]) =>
          put(`queries/${name}.json`, JSON.stringify(query))
        )
      )),
    ],
  })
  return { host, as, proposal, system: createTestSixb(host) }
}

const refused = (promise: Promise<unknown>) => promise.catch((error: unknown) => error)

/** The client a contract's query reaches, from the contract that holds the document. */
const CLIENT = {
  kind: "traverse",
  input: { kind: "holder" },
  linkId: "client",
  direction: "outgoing",
}

describe("a designed document's live data", () => {
  // Reproduce by dropping checkDocumentFields from prepareArtifactVersion: the holder has no links
  // to read, and a field that reads nothing is not warned about.
  test("is checked as its author publishes it: the holder's links, and fields that read nothing", async () => {
    const { as, proposal } = setup()
    const published = await as("alice").artifacts.create(
      await proposal(
        `<h1 data-sixb-field="client.name">Client</h1>
         <p data-sixb-field="number">Q-1</p>
         <p data-sixb-field="nickname">-</p>
         <p data-sixb-field="client.motto">-</p>
         <p data-sixb-field="query:client.total">0</p>
         <p data-sixb-field="query:missing.total">0</p>`,
        { client: CLIENT }
      )
    )

    expect(published.version.outline).toMatchObject({
      holder: { objectTypeId: "Contract", links: ["client"] },
    })
    expect(published.warnings.map((warning) => [warning.code, warning.message])).toEqual([
      [
        "field_unknown",
        `data-sixb-field="nickname" reads 'nickname', which a Contract does not hold. It keeps the text written in it.`,
      ],
      [
        "field_unknown",
        `data-sixb-field="client.motto" reads 'motto', which what 'client' reaches does not hold. It keeps the text written in it.`,
      ],
      [
        "field_unknown",
        `data-sixb-field="query:missing.total" names no query: add queries/missing.json. It keeps the text written in it.`,
      ],
    ])
  })

  test("is refused where it cannot run: a query named holder, no type named, one its author cannot read", async () => {
    const { as, proposal } = setup()
    const alice = as("alice")
    expect(
      await refused(alice.artifacts.create(await proposal("<p>-</p>", { holder: CLIENT })))
    ).toMatchObject({
      code: "invalid_artifact",
      message: expect.stringContaining('"holder" is what'),
    })

    expect(
      await refused(alice.artifacts.create(await proposal("<p>-</p>", { client: CLIENT }, "")))
    ).toMatchObject({
      code: "invalid_artifact",
      message: expect.stringContaining('names its type with <meta name="sixb:object-type">'),
    })

    // An author who cannot read the type it names cannot publish it.
    expect(
      await refused(as("bob", ["Organization"]).artifacts.create(await proposal("<p>-</p>")))
    ).toMatchObject({
      code: "invalid_artifact",
      message: expect.stringContaining("which you cannot read"),
    })
  })

  // Reproduce by answering "holder" from a query file in ArtifactsRuntime.query: there is none, and
  // the holder is not found. Dropping requireHolder's second holder: two contracts read as one.
  test("reads the one object that holds it, and queries that start from it", async () => {
    const { as, proposal, system } = setup()
    const alice = as("alice")
    const { artifact } = await alice.artifacts.create(
      await proposal(`<h1 data-sixb-field="client.name">Client</h1>`, { client: CLIENT })
    )
    const holder = () => alice.artifacts.query(artifact.id, "holder")

    // A template, which no contract holds yet, keeps its written text.
    expect(await refused(holder())).toMatchObject({ code: "holder_not_found" })
    expect(await refused(alice.artifacts.query(artifact.id, "client"))).toMatchObject({
      code: "holder_not_found",
    })

    const harbor = await system
      .objects(Organization)
      .upsert({ properties: { id: "o1", name: "Harbor Co" } })
    await system
      .objects(Contract)
      .upsert({ properties: { id: "c1", number: "Q-881", document: artifactRef(artifact.id) } })
    await system.objects(Contract).byId("c1").link(Contract.l.client, harbor)

    const read = await holder()
    if (read?.kind !== "objects") throw new Error("Expected the holder.")
    expect(read.objects).toMatchObject([
      {
        primaryId: "c1",
        properties: { number: "Q-881" },
        links: { client: { primaryId: "o1", properties: { name: "Harbor Co" } } },
      },
    ])
    const clients = await alice.artifacts.query(artifact.id, "client")
    if (clients?.kind !== "objects") throw new Error("Expected the client.")
    expect(clients.objects.map((row) => row.properties.name)).toEqual(["Harbor Co"])

    // Two contracts that hold it: neither is its holder.
    await system
      .objects(Contract)
      .upsert({ properties: { id: "c2", document: artifactRef(artifact.id) } })
    expect(await refused(holder())).toMatchObject({ code: "holder_not_found" })
  })
})
