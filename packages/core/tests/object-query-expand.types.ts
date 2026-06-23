/**
 * Type-level assertions for `.expand()` authoring + the row `.links` type.
 *
 * The file compiling at all is the core assertion: the expand builder types
 * resolve the 2-hop ADN graph AND the `Folder.parent` self-cycle with NO TS2589
 * ("type instantiation is excessively deep"). The `@ts-expect-error` lines prove
 * links and `orderBy` properties are constrained to the resolved target type on
 * the full-registry (server) path.
 *
 * Slice 3 adds the row-typing section: each `.expand(...)` widens the row's
 * `.links` (cardinality `"one"` → `Target | null`, `"many"` → `Target[]`, with
 * optional `.linkProperties` and nested `.links`), precise on the server path and
 * degraded-but-compiling on the client path until the generated registry lands.
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
    link("contacts", Contact, { cardinality: "many" }),
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

  // `.expand` is additive: the result type stays Project (only the accumulated
  // `.links` shape widens), so a second expand still accepts a Project link (a
  // changed result type would reject it).
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

// ── Row `.links` typing (slice 3) ──────────────────────────────────────────
//
// Extract the row from a built query the same way production reads it: a direct
// conditional `infer` on the `first()` terminal (never `Awaited<ReturnType<…>>`,
// which tips this over TS2589). `RowOf` mirrors the client `BuiltRow`. The build
// thunks are never called — only their return type is read — so this file stays
// execution-free like the authoring section above.
type RowOf<TBuilt> = TBuilt extends { first(): Promise<infer TRow> } ? NonNullable<TRow> : never

// Server path: a "one" link, a bounded "many" link, and a 2-hop. The builder is
// referenced only by `typeof` (never executed — this file is typecheck-only,
// like the spike).
const builtProjects = projects
  .expand(Project.l.projectFolder)
  .expand(Project.l.contacts, { limit: 5 })
  .expand(Project.l.opportunity, (o) =>
    o.expand(Opportunity.l.company).expand(Opportunity.l.contact)
  )
type ProjectRow = RowOf<typeof builtProjects>

function projectRowAssertions(row: ProjectRow): void {
  // Root object stays precisely typed.
  const _rootId: "Project" = row.objectTypeId
  const _name: string = row.properties.name

  // "one" cardinality → object | null; target resolves to the literal type.
  const _pfId: "ProjectFolder" = row.links.projectFolder!.objectTypeId
  const _nas: number | null | undefined = row.links.projectFolder!.properties.nasComplianceScore

  // "many" cardinality → array (not nullable).
  const _firstContactId: "Contact" | undefined = row.links.contacts[0]?.objectTypeId

  // Edge metadata is optional (the executor attaches it only when present).
  const _edge: Record<string, unknown> | undefined = row.links.opportunity!.linkProperties

  // 2-hop: opportunity → { company, contact }, the recursion-prone path.
  const _coId: "Company" = row.links.opportunity!.links.company!.objectTypeId
  const _coName: string = row.links.opportunity!.links.company!.properties.name
  const _ctId: "Contact" = row.links.opportunity!.links.contact!.objectTypeId

  // @ts-expect-error — projectFolder was not nested-expanded, so it has no `.links`.
  void row.links.projectFolder!.links
  // @ts-expect-error — projectFolder resolves to "ProjectFolder", not "Opportunity".
  const _wrong: "Opportunity" = row.links.projectFolder!.objectTypeId

  void [_rootId, _name, _pfId, _nas, _firstContactId, _edge, _coId, _coName, _ctId, _wrong]
}
void projectRowAssertions

// A query with no `.expand(...)` returns the plain row — no `.links` field.
type PlainRow = RowOf<typeof projects>
function plainRowAssertions(row: PlainRow): void {
  const _id: "Project" = row.objectTypeId
  // @ts-expect-error — without an expand the row has no `.links`.
  void row.links
  void _id
}
void plainRowAssertions

// Self-cycle: Folder.parent → Folder.parent resolves by id, no infinite depth.
const builtFolders = folders.expand(Folder.l.parent, (p) => p.expand(Folder.l.parent))
type FolderRow = RowOf<typeof builtFolders>
function folderRowAssertions(row: FolderRow): void {
  const _p1Id: "Folder" = row.links.parent!.objectTypeId
  const _p2Id: "Folder" = row.links.parent!.links.parent!.objectTypeId
  void [_p1Id, _p2Id]
}
void folderRowAssertions

// Client path: the nested target degrades to the base type, so `objectTypeId`
// widens to `string` — but the row still compiles (no TS2589). The gap the
// generated client registry closes.
const builtDegraded = startTypeOnly.expand(Project.l.opportunity)
type DegradedRow = RowOf<typeof builtDegraded>
function degradedRowAssertions(row: DegradedRow): void {
  // @ts-expect-error — no registry: the target is not resolved to "Opportunity".
  const _id: "Opportunity" = row.links.opportunity!.objectTypeId
  void _id
}
void degradedRowAssertions
