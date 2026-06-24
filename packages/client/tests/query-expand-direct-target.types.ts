import { defineObjectType, link, prop } from "@sixb/core/ontology"
import { objects } from "../src/query"

const Region = defineObjectType({
  id: "DirectRegion",
  name: "Region",
  properties: [prop("code", "string", { required: true })],
})

const Customer = defineObjectType({
  id: "DirectCustomer",
  name: "Customer",
  properties: [prop("name", "string", { required: true })],
  links: [link("region", Region, { cardinality: "one" })],
})

const User = defineObjectType({
  id: "DirectUser",
  name: "User",
  properties: [prop("email", "string", { required: true })],
  links: [link("region", Region, { cardinality: "one" })],
})

const Team = defineObjectType({
  id: "DirectTeam",
  name: "Team",
  properties: [prop("slug", "string", { required: true })],
})

const Project = defineObjectType({
  id: "DirectProject",
  name: "Project",
  properties: [prop("name", "string", { required: true })],
  links: [
    link("customer", Customer, { cardinality: "one" }),
    link("owner", [User, Team], { cardinality: "one" }),
  ],
})

type RowOf<TBuilt> = TBuilt extends { first(): Promise<infer TRow> } ? NonNullable<TRow> : never

const built = objects(Project)
  .query()
  .expand(Project.l.customer, (customer) => customer.expand(Customer.l.region))
  .expand(Project.l.owner, (owner) => owner.expand(User.l.region))

type ProjectRow = RowOf<typeof built>

function projectRowAssertions(row: ProjectRow): void {
  const projectTypeId: "DirectProject" = row.objectTypeId
  const projectName: string = row.properties.name
  const customerTypeId: "DirectCustomer" = row.links.customer!.objectTypeId
  const customerName: string = row.links.customer!.properties.name
  const regionTypeId: "DirectRegion" = row.links.customer!.links.region!.objectTypeId
  const regionCode: string = row.links.customer!.links.region!.properties.code

  const owner = row.links.owner
  const ownerTypeId: "DirectUser" | "DirectTeam" | undefined = owner?.objectTypeId
  const ownerTypeIds: ("DirectUser" | "DirectTeam" | undefined)[] = [row].map(
    (project) => project.links.owner?.objectTypeId
  )
  if (owner?.objectTypeId === "DirectUser") {
    const email: string = owner.properties.email
    const userRegionCode: string = owner.links.region!.properties.code
    // @ts-expect-error — DirectUser owners do not have Team properties.
    const slug: string = owner.properties.slug
    void [email, userRegionCode, slug]
  }
  if (owner?.objectTypeId === "DirectTeam") {
    const slug: string = owner.properties.slug
    // @ts-expect-error — DirectTeam owners do not have User properties.
    const email: string = owner.properties.email
    // @ts-expect-error — User-only nested expansion is not present on Team rows.
    const userRegion = owner.links.region
    void [slug, email, userRegion]
  }

  void [
    projectTypeId,
    projectName,
    customerTypeId,
    customerName,
    regionTypeId,
    regionCode,
    ownerTypeId,
    ownerTypeIds,
  ]
}

void projectRowAssertions
