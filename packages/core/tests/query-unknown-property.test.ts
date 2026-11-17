import { describe, expect, test } from "bun:test"
import { can, defineGroup, defineObjectType, defineRole, link, prop, SixbHost } from "../src"
import { createAuthorizedObjectReader } from "../src/execution/authorized-object-reader"
import { createTestingScope } from "../src/execution/scopes"
import type { OntologyRegistry } from "../src/ontology"
import { contextIn } from "./helpers/view-conditions"
import { createTestRuntimeDeps } from "./test-runtime-deps"

// A reader who misnames a property learns the type's properties, as its discovery shows them, and
// nothing of a type it cannot view.

const projectId = "query-unknown-property"

const Payroll = defineObjectType({
  id: "payroll",
  name: "Payroll",
  properties: [
    prop("id", "string", { required: true, primary: true }),
    prop("employee", "string"),
    prop("salary", "double"),
  ],
})

const Note = defineObjectType({
  id: "note",
  name: "Note",
  properties: [prop("id", "string", { required: true, primary: true }), prop("title", "string")],
  links: [link("payroll", Payroll)],
})

const staff = defineGroup("staff")
const notes = defineRole("notes", { grantedTo: [staff], grants: [can.view(Note)] })

function deploy() {
  const host = new SixbHost({
    id: projectId,
    ontology: [Note, Payroll],
    groups: [staff],
    roles: [notes],
    ...createTestRuntimeDeps(),
  })

  return createAuthorizedObjectReader({
    scope: createTestingScope({ projectId, context: contextIn(host, [staff.id]) }),
    ontology: host.definitions.ontology as OntologyRegistry,
    objectStorage: host.storage.objects,
  })
}

const misnamed = (objectTypeId: string) => ({
  kind: "project" as const,
  properties: ["updatedAt"],
  input: { kind: "start" as const, objectTypeId },
})

describe("a query on a property its type lacks", () => {
  // Removal proof: drop `discovery` from the reader's executor options; the list goes missing.
  test("lists the properties of a type the reader views", async () => {
    const reader = deploy()

    const query = await reader.executeQuery({ query: misnamed(Note.id) }).catch((error) => error)
    const links = await reader
      .queryLinks({ query: misnamed(Note.id), direction: "outgoing" })
      .catch((error) => error)

    const expected =
      "Property 'updatedAt' does not exist on object type 'note'; its properties are id, title"
    expect(query.message).toContain(expected)
    expect(links.message).toContain(expected)
  })

  // Validation runs before the grants are checked, so its message must hold nothing the reader
  // cannot discover. Removal proof: list from the registry instead of the reader's discovery.
  test("names no property of a type the reader cannot view", async () => {
    const reader = deploy()

    const error = await reader.executeQuery({ query: misnamed(Payroll.id) }).catch((error) => error)

    expect(error.message).toContain("Property 'updatedAt' does not exist on object type 'payroll'")
    expect(error.message).not.toContain("salary")
    expect(error.message).not.toContain("its properties")
  })
})
