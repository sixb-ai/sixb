import { describe, expect, test } from "bun:test"
import { defineObjectType, link, type ObjectQuery, OntologyRegistry, prop } from "../src"
import { normalizeObjectQuery, validateObjectQuery } from "../src/objects/query"

const primary = prop("id", "string", { required: true, primary: true })
const object = (id: string, extra: object = {}) =>
  defineObjectType({ id, name: id, properties: [primary], ...extra })

const Site = object("Site")
const Note = object("Note")
const Party = object("Party", { links: [link("site", Site, { cardinality: "one" })] })
const Vendor = defineObjectType({ id: "Vendor", name: "Vendor", extends: Party, properties: [] })
const Any = defineObjectType({
  id: "Any",
  name: "Any",
  extends: Party,
  properties: [],
  links: [link.ref("site", ["Site", "*"], { cardinality: "one" })],
})
const Quote = object("Quote", {
  links: [link("party", Party, { cardinality: "one" }), link("place", [Party, Site])],
})
const Invoice = object("Invoice", { links: [link("party", Party), link("owner", Site)] })
const Comment = object("Comment", { links: [link("owner", Note)] })

const ontology = new OntologyRegistry({
  sources: [Site, Note, Party, Vendor, Quote, Invoice, Comment],
})
const withWildcardSubtype = new OntologyRegistry({ sources: [Site, Party, Any] })

function endpoints(query: ObjectQuery, registry = ontology): unknown {
  const validated = validateObjectQuery(query, {
    ontology: registry,
    resolveLinkEndpoints: true,
    normalize: false,
  }).query
  if (validated.kind === "traverse") return validated.endpointObjectTypeIds
  if (validated.kind === "expand") return validated.expansions[0]?.endpointObjectTypeIds
  throw new Error(`Unexpected ${validated.kind}`)
}

const start = (objectTypeId: string): ObjectQuery => ({ kind: "start", objectTypeId })
const follow = (from: string, linkId: string, direction: "outgoing" | "incoming" = "outgoing") =>
  ({ kind: "traverse", input: start(from), linkId, direction }) satisfies ObjectQuery

describe("link endpoints", () => {
  test("an outgoing link reaches its targets and their subtypes", () => {
    expect(endpoints(follow("Quote", "party"))).toEqual(["Party", "Vendor"])
    expect(endpoints(follow("Quote", "place"))).toEqual(["Party", "Site", "Vendor"])
  })

  test("an incoming link names only the types whose link can target these parents", () => {
    expect(endpoints(follow("Site", "owner", "incoming"))).toEqual(["Invoice"])
    expect(endpoints(follow("Note", "owner", "incoming"))).toEqual(["Comment"])
  })

  // Removal proof: drop the touchedObjectTypeIds loop in withLinkEndpoints. A reader then gets
  // VendorNote or Secret rows with no check of a grant on either.
  test("every endpoint is checked for a read grant", () => {
    const VendorNote = object("VendorNote", { links: [link("about", Vendor)] })
    const PartyNote = object("PartyNote", { links: [link("about", Party)] })
    const registry = new OntologyRegistry({ sources: [Site, Party, Vendor, VendorNote, PartyNote] })
    const incoming = validateObjectQuery(follow("Party", "about", "incoming"), {
      ontology: registry,
      resolveLinkEndpoints: true,
      normalize: false,
    })
    if (incoming.query.kind !== "traverse") throw new Error("Expected a traversal")

    // A Party row can be a Vendor, so a note about a Vendor is a legal edge from it.
    expect([...(incoming.query.endpointObjectTypeIds ?? [])].sort()).toEqual([
      "PartyNote",
      "VendorNote",
    ])
    expect(incoming.touchedObjectTypeIds).toContain("VendorNote")

    const Secret = object("Secret")
    const Base = object("Base", { links: [link("to", Site)] })
    const Override = defineObjectType({
      id: "Override",
      name: "Override",
      extends: Base,
      properties: [],
      links: [link("to", Secret)],
    })
    const overriding = new OntologyRegistry({ sources: [Site, Secret, Base, Override] })
    const outgoing = validateObjectQuery(follow("Base", "to"), {
      ontology: overriding,
      resolveLinkEndpoints: true,
      normalize: false,
    })
    expect(outgoing.touchedObjectTypeIds).toContain("Secret")
  })

  test("a subtype whose override cannot target these parents is left out", () => {
    const Note = object("Note2", { links: [link("about", Party)] })
    const Audit = defineObjectType({
      id: "Audit",
      name: "Audit",
      extends: Note,
      properties: [],
      links: [link("about", Site)],
    })
    const registry = new OntologyRegistry({ sources: [Site, Party, Note, Audit] })

    expect(endpoints(follow("Party", "about", "incoming"), registry)).toEqual(["Note2"])
  })

  test("an incoming link from a subtype finds links to its parent type", () => {
    expect(endpoints(follow("Vendor", "party", "incoming"))).toEqual(["Quote", "Invoice"])
  })

  test("a pinned source is the only endpoint", () => {
    expect(
      endpoints({ ...follow("Party", "party", "incoming"), sourceObjectTypeId: "Invoice" })
    ).toEqual(["Invoice"])
  })

  // Removal proof: drop the wildcard check in linkTargetObjectTypeIds. The subtype's wildcard then reads as a
  // type named "*", which hides its edges to every other type.
  test("a subtype that overrides a link with a wildcard names nothing", () => {
    expect(endpoints(follow("Party", "site"), withWildcardSubtype)).toBeUndefined()
  })

  test("an expansion and its nested expansions name their endpoints", () => {
    const validated = validateObjectQuery(
      {
        kind: "expand",
        input: start("Quote"),
        expansions: [
          {
            linkId: "party",
            direction: "outgoing",
            expand: [{ linkId: "site", direction: "outgoing" }],
          },
        ],
      },
      { ontology, resolveLinkEndpoints: true, normalize: false }
    ).query
    if (validated.kind !== "expand") throw new Error("Expected an expand")

    expect(validated.expansions[0]?.endpointObjectTypeIds).toEqual(["Party", "Vendor"])
    expect(validated.expansions[0]?.expand?.[0]?.endpointObjectTypeIds).toEqual(["Site"])
  })

  test("a value in the query is replaced", () => {
    expect(endpoints({ ...follow("Quote", "party"), endpointObjectTypeIds: ["Site"] })).toEqual([
      "Party",
      "Vendor",
    ])
  })

  test("normalizing a resolved query keeps what it resolved", () => {
    const expanded: ObjectQuery = {
      kind: "expand",
      input: start("Quote"),
      expansions: [{ linkId: "party", direction: "outgoing", endpointObjectTypeIds: ["Party"] }],
    }
    const normalized = normalizeObjectQuery(expanded)
    if (normalized.kind !== "expand") throw new Error("Expected an expand")

    expect(normalized.expansions[0]?.endpointObjectTypeIds).toEqual(["Party"])
  })

  test("is not added unless asked for", () => {
    const { query } = validateObjectQuery(follow("Quote", "party"), { ontology, normalize: false })
    expect(JSON.stringify(query)).not.toContain("endpointObjectTypeIds")
  })
})
