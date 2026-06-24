import { defineObjectType, link, prop } from "@sixb/core/ontology"
import { objects } from "../src/query"

const Region = defineObjectType({
  id: "ManifestRegion",
  name: "Region",
  properties: [prop("code", "string", { required: true })],
})

const Customer = defineObjectType({
  id: "ManifestCustomer",
  name: "Customer",
  properties: [prop("name", "string", { required: true })],
  links: [link("region", "ManifestRegion", { cardinality: "one" })],
})

const Project = defineObjectType({
  id: "ManifestProject",
  name: "Project",
  properties: [prop("name", "string", { required: true })],
  links: [link("customer", "ManifestCustomer", { cardinality: "one" })],
})

declare module "@sixb/core/ontology" {
  interface SixbObjectTypeMap {
    ManifestCustomer: typeof Customer
    ManifestProject: typeof Project
    ManifestRegion: typeof Region
  }
}

type RowOf<TBuilt> = TBuilt extends { first(): Promise<infer TRow> } ? NonNullable<TRow> : never

const built = objects(Project)
  .query()
  .expand(Project.l.customer, (customer) => customer.expand(Customer.l.region))

type ProjectRow = RowOf<typeof built>

function projectRowAssertions(row: ProjectRow): void {
  const projectTypeId: "ManifestProject" = row.objectTypeId
  const projectName: string = row.properties.name
  const customerTypeId: "ManifestCustomer" = row.links.customer!.objectTypeId
  const customerName: string = row.links.customer!.properties.name
  const regionTypeId: "ManifestRegion" = row.links.customer!.links.region!.objectTypeId
  const regionCode: string = row.links.customer!.links.region!.properties.code

  // @ts-expect-error — the generated-style map resolves customer to Customer, not Region.
  const wrongCustomerTypeId: "ManifestRegion" = row.links.customer!.objectTypeId

  void [
    projectTypeId,
    projectName,
    customerTypeId,
    customerName,
    regionTypeId,
    regionCode,
    wrongCustomerTypeId,
  ]
}

void projectRowAssertions
