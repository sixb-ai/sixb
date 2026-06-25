// Typecheck-only proof for the slice-5 `BuiltRow.links` hook fix: a row coming
// out of `useObjectsQuery`/`useObjectsInfinite` must carry PRECISE nested
// `.links` AND survive `.map()`/`.flatMap()` over the result set WITHOUT tripping
// TS2589. The builder-path proof (object-query-expand-recursion.types.ts) only
// exercises `first()`/`RowOf`; the hook path re-attaches the full `ExpandedLinkType`
// recursion via `BuiltRow`'s `& { links: TLinks }` passthrough (query-hooks.ts),
// which is exactly the recursion-prone combo real app code hits in components.
// This mirrors that stress (polymorphic target, "many" arrays, 5-deep self-cycle)
// through the hooks. Augmentation injects the ontology so nested targets resolve.
import { defineObjectType, link, prop } from "@sixb/core/ontology"
import { objects } from "../src/query"
import { useObjectsInfinite, useObjectsQuery } from "../src/query-hooks"

const HookDepartment = defineObjectType({
  id: "HookDepartment",
  name: "Department",
  properties: [prop("name", "string", { required: true })],
})

const HookSkill = defineObjectType({
  id: "HookSkill",
  name: "Skill",
  properties: [prop("name", "string", { required: true })],
})

const HookUser = defineObjectType({
  id: "HookUser",
  name: "User",
  properties: [prop("email", "string", { required: true })],
  links: [
    link.self("manager", { cardinality: "one" }),
    link.ref("department", "HookDepartment", { cardinality: "one" }),
    link.ref("skills", "HookSkill", { cardinality: "many" }),
  ],
})

const HookTeam = defineObjectType({
  id: "HookTeam",
  name: "Team",
  properties: [prop("slug", "string", { required: true })],
  links: [link.ref("members", "HookUser", { cardinality: "many" })],
})

const HookProject = defineObjectType({
  id: "HookProject",
  name: "Project",
  properties: [prop("name", "string", { required: true })],
  links: [link.ref("owner", ["HookUser", "HookTeam"], { cardinality: "one" })],
})

const HookFolder = defineObjectType({
  id: "HookFolder",
  name: "Folder",
  properties: [prop("name", "string", { required: true })],
  links: [
    link.self("parent", { cardinality: "one" }),
    link.self("children", { cardinality: "many" }),
  ],
})

declare module "@sixb/core/ontology" {
  interface SixbObjectTypeMap {
    HookDepartment: typeof HookDepartment
    HookFolder: typeof HookFolder
    HookProject: typeof HookProject
    HookSkill: typeof HookSkill
    HookTeam: typeof HookTeam
    HookUser: typeof HookUser
  }
}

// Polymorphic owner + nested "many" arrays, hydrated, then consumed through the
// useObjectsQuery row in `.map()`/`.flatMap()`.
const projectQuery = objects(HookProject)
  .query()
  .expand(HookProject.l.owner, (owner) =>
    owner
      .expand(HookUser.l.department)
      .expand(HookUser.l.skills, { limit: 5 })
      .expand(HookTeam.l.members, { limit: 10 }, (member) => member.expand(HookUser.l.manager))
  )

function useProjectGraphView(): void {
  const { data } = useObjectsQuery(projectQuery)
  const rows = data?.objects ?? []

  // Collection helpers reaching nested `.links` — the recursion-prone real path.
  const ownerLabels: string[] = rows.map((p) => p.links.owner?.objectTypeId ?? "none")
  const teamMemberEmails: string[] = rows.flatMap((p) => {
    const owner = p.links.owner
    return owner?.objectTypeId === "HookTeam"
      ? owner.links.members.map((m) => m.properties.email)
      : []
  })
  const managerEmails: (string | undefined)[] = rows.flatMap((p) => {
    const owner = p.links.owner
    return owner?.objectTypeId === "HookTeam"
      ? owner.links.members.map((m) => m.links.manager?.properties.email)
      : []
  })

  // Per-row precision + polymorphic per-branch narrowing, through the hook row.
  const first = rows[0]
  if (first) {
    const owner = first.links.owner
    const ownerTypeId: "HookUser" | "HookTeam" | undefined = owner?.objectTypeId
    if (owner?.objectTypeId === "HookUser") {
      const departmentName: string | undefined = owner.links.department?.properties.name
      const skillNames: string[] = owner.links.skills.map((s) => s.properties.name)
      // @ts-expect-error — `members` is a Team-only expansion, absent on User rows.
      void owner.links.members
      void [departmentName, skillNames]
    }
    if (owner?.objectTypeId === "HookTeam") {
      const memberEmails: string[] = owner.links.members.map((m) => m.properties.email)
      // @ts-expect-error — `department` is a User-only expansion, absent on Team rows.
      void owner.links.department
      void memberEmails
    }
    void ownerTypeId
  }

  void [ownerLabels, teamMemberEmails, managerEmails]
}
void useProjectGraphView

// 5-deep self-cycle + nested "many" children, through the infinite hook.
const folderQuery = objects(HookFolder)
  .query()
  .expand(HookFolder.l.parent, (p1) =>
    p1.expand(HookFolder.l.parent, (p2) =>
      p2.expand(HookFolder.l.parent, (p3) =>
        p3.expand(HookFolder.l.parent, (p4) => p4.expand(HookFolder.l.parent))
      )
    )
  )
  .expand(HookFolder.l.children, { limit: 10 }, (child) =>
    child.expand(HookFolder.l.children, { limit: 5 }, (grandchild) =>
      grandchild.expand(HookFolder.l.parent)
    )
  )

function useFolderTreeView(): void {
  const { data } = useObjectsInfinite(folderQuery, { pageSize: 20 })
  const rows = data?.pages.flatMap((page) => page.objects) ?? []

  const ancestorNames: (string | undefined)[] = rows.map(
    (folder) =>
      folder.links.parent?.links.parent?.links.parent?.links.parent?.links.parent?.properties.name
  )
  const descendantNames: string[] = rows.flatMap((folder) =>
    folder.links.children.flatMap((child) =>
      child.links.children.map((g) => g.links.parent?.properties.name ?? g.properties.name)
    )
  )
  const descendantTypeIds: ("HookFolder" | undefined)[] = rows.flatMap((folder) =>
    folder.links.children.flatMap((child) =>
      child.links.children.map((g) => g.links.parent?.objectTypeId)
    )
  )

  void [ancestorNames, descendantNames, descendantTypeIds]
}
void useFolderTreeView
