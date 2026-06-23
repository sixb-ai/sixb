/**
 * Type-level assertions for `.expand()` authoring (slice 1).
 *
 * The file compiling at all is the core assertion: the expand builder types
 * resolve the 2-hop ADN graph AND the `Folder.parent` self-cycle with NO TS2589
 * ("type instantiation is excessively deep"). The `@ts-expect-error` lines prove
 * links and `orderBy` properties are constrained to the resolved target type on
 * the full-registry (server) path.
 *
 * The `.links` row type and client-side registry precision arrive in later
 * slices; here `.expand(...)` returns the same builder type it was called on.
 */
import { defineObjectType, link, type ObjectQueryBuilder, prop } from "../src"

const Company = defineObjectType({
  id: "Company",
  name: "Company",
  properties: [
    prop("id", "string", { required: true, primary: true }),
    prop("name", "string", { required: true }),
  ],
})

const Contact = defineObjectType({
  id: "Contact",
  name: "Contact",
  properties: [
    prop("id", "string", { required: true, primary: true }),
    prop("displayName", "string", { required: true }),
  ],
})

const Opportunity = defineObjectType({
  id: "Opportunity",
  name: "Opportunity",
  properties: [
    prop("id", "string", { required: true, primary: true }),
    prop("title", "string", { required: true }),
    prop("createdAt", "timestamp", {
      query: { searchable: true, filterable: true, sortable: true },
    }),
  ],
  links: [
    link("contact", Contact, { cardinality: "one" }),
    link("company", Company, { cardinality: "one" }),
  ],
})

const Folder = defineObjectType({
  id: "Folder",
  name: "Folder",
  properties: [
    prop("id", "string", { required: true, primary: true }),
    prop("name", "string", { required: true }),
  ],
  links: [link("parent", "Folder", { cardinality: "one" })],
})

const ProjectFolder = defineObjectType({
  id: "ProjectFolder",
  name: "Project Folder",
  extends: Folder,
  properties: [prop("nasComplianceScore", "double", { nullable: true })],
})

const Project = defineObjectType({
  id: "Project",
  name: "Project",
  properties: [
    prop("id", "string", { required: true, primary: true }),
    prop("name", "string", { required: true }),
    prop("updatedAt", "timestamp", {
      query: { searchable: true, filterable: true, sortable: true },
    }),
  ],
  links: [
    link("opportunity", Opportunity, { cardinality: "one" }),
    link("projectFolder", ProjectFolder, { cardinality: "one" }),
  ],
})

type AppRegistry =
  | typeof Project
  | typeof Opportunity
  | typeof Company
  | typeof Contact
  | typeof Folder
  | typeof ProjectFolder

// Server path: `objects(T)` binds the full registry, so nested targets resolve.
declare const projects: ObjectQueryBuilder<typeof Project, AppRegistry, []>
declare const folders: ObjectQueryBuilder<typeof Folder, AppRegistry, []>
// Client path today: only the start type is registered, so nested targets degrade.
declare const startTypeOnly: ObjectQueryBuilder<typeof Project, typeof Project, []>

function authoring(): void {
  // 2-hop, precise: Project -> opportunity -> { company, contact }.
  projects
    .expand(Project.l.projectFolder)
    .expand(Project.l.opportunity, (o) =>
      o.expand(Opportunity.l.company).expand(Opportunity.l.contact)
    )

  // Bounded "many": options object + `orderBy` typed against the target type.
  projects.expand(Project.l.opportunity, {
    limit: 5,
    orderBy: [{ property: Opportunity.p.createdAt, direction: "desc" }],
  })

  // Self-cycle resolves by id against the registry — no infinite instantiation.
  folders.expand(Folder.l.parent, (p) => p.expand(Folder.l.parent))

  // `.expand` is additive: it returns the same Project-typed builder, so a second
  // expand still accepts a Project link (a changed result type would reject it).
  projects.expand(Project.l.projectFolder).expand(Project.l.opportunity)

  // @ts-expect-error — `company` is an Opportunity link, not an outgoing Project link.
  projects.expand(Opportunity.l.company)

  projects.expand(Project.l.opportunity, (o) =>
    o.expand(
      // @ts-expect-error — `projectFolder` is a Project link, not on the Opportunity target.
      Project.l.projectFolder
    )
  )

  // @ts-expect-error — `name` is a Project property, not on the Opportunity target.
  projects.expand(Project.l.opportunity, { orderBy: [{ property: Project.p.name }] })

  // Without a full registry the nested target degrades to the base type, so even
  // an unrelated link compiles — the gap a generated client registry closes.
  startTypeOnly.expand(Project.l.opportunity, (o) => o.expand(Folder.l.parent))
}

void authoring
