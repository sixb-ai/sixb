import { type AgentToolRuntimeFacade, defineObjectType, type ObjectReader, prop } from "../src"

const Organization = defineObjectType({
  id: "organization",
  name: "Organization",
  properties: [
    prop("id", "string", { required: true, primary: true }),
    prop("name", "string"),
    prop("logo", "fileRef"),
    prop("documents", { type: "array", items: "fileRef" }),
  ],
})

declare const reader: ObjectReader
const acme = reader.objects(Organization).byId("acme")

acme.file(Organization.p.logo)
acme.file(Organization.p.documents, 0)

// @ts-expect-error only file properties can be opened
acme.file(Organization.p.name)
// @ts-expect-error a list of files needs the index of the file to open
acme.file(Organization.p.documents)
// @ts-expect-error a single file takes no index
acme.file(Organization.p.logo, 0)

// Agent tools read files through the same object sets.
declare const tool: AgentToolRuntimeFacade
tool.objects(Organization).byId("acme").file(Organization.p.logo)
