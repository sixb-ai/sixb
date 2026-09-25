/**
 * Recursion stress for expanded rows: a polymorphic id-only target, "many" arrays mapped over, and
 * a five-deep self-cycle. The owner link names its targets by id, so they resolve through the
 * generated registry — the path every app with `sixb typegen` takes.
 */
import type { ObjectQueryBuilder } from "@sixb/core"
import { StressFolder, StressProject, StressTeam, StressUser } from "./ontology/stress"

declare const projects: ObjectQueryBuilder<typeof StressProject>
declare const folders: ObjectQueryBuilder<typeof StressFolder>

type RowOf<TBuilt> = TBuilt extends { first(): Promise<infer TRow> } ? NonNullable<TRow> : never

const builtProjects = projects.expand(StressProject.l.owner, (owner) =>
  owner
    .expand(StressUser.l.department)
    .expand(StressUser.l.skills, { limit: 5 })
    .expand(StressTeam.l.members, { limit: 10 }, (member) => member.expand(StressUser.l.manager))
)
type ProjectRow = RowOf<typeof builtProjects>

function projectRowAssertions(row: ProjectRow): void {
  const owner = row.links.owner
  const ownerTypeId: "StressUser" | "StressTeam" | undefined = owner?.objectTypeId

  if (owner?.objectTypeId === "StressUser") {
    const departmentName: string | undefined = owner.links.department?.properties.name
    const skillNames: string[] = owner.links.skills.map((skill) => skill.properties.name)
    // @ts-expect-error — Team-only nested expansion is not present on User rows.
    const members = owner.links.members
    void [departmentName, skillNames, members]
  }

  if (owner?.objectTypeId === "StressTeam") {
    const memberEmails: string[] = owner.links.members.map((member) => member.properties.email)
    const managerEmails: (string | undefined)[] = owner.links.members.map(
      (member) => member.links.manager?.properties.email
    )
    // @ts-expect-error — User-only nested expansion is not present on Team rows.
    const department = owner.links.department
    void [memberEmails, managerEmails, department]
  }

  void ownerTypeId
}
void projectRowAssertions

function projectCollectionAssertions(rows: ProjectRow[]): void {
  const ownerLabels: string[] = rows.map((project) => project.links.owner?.objectTypeId ?? "none")
  const memberEmails: string[] = rows.flatMap((project) => {
    const owner = project.links.owner
    return owner?.objectTypeId === "StressTeam"
      ? owner.links.members.map((member) => member.properties.email)
      : []
  })
  const expandedOwnerCount: number = rows.reduce(
    (total, project) => total + (project.links.owner ? 1 : 0),
    0
  )

  void [ownerLabels, memberEmails, expandedOwnerCount]
}
void projectCollectionAssertions

const builtFolders = folders
  .expand(StressFolder.l.parent, (p1) =>
    p1.expand(StressFolder.l.parent, (p2) =>
      p2.expand(StressFolder.l.parent, (p3) =>
        p3.expand(StressFolder.l.parent, (p4) => p4.expand(StressFolder.l.parent))
      )
    )
  )
  .expand(StressFolder.l.children, { limit: 10 }, (child) =>
    child.expand(StressFolder.l.children, { limit: 5 }, (grandchild) =>
      grandchild.expand(StressFolder.l.parent)
    )
  )
type FolderRow = RowOf<typeof builtFolders>

function folderRowAssertions(row: FolderRow): void {
  const ancestorNames: (string | undefined)[] = [row].map(
    (folder) =>
      folder.links.parent?.links.parent?.links.parent?.links.parent?.links.parent?.properties.name
  )
  const descendantNames: string[] = row.links.children.flatMap((child) =>
    child.links.children.map(
      (grandchild) => grandchild.links.parent?.properties.name ?? grandchild.properties.name
    )
  )
  const descendantTypeIds: ("StressFolder" | undefined)[] = row.links.children.flatMap((child) =>
    child.links.children.map((grandchild) => grandchild.links.parent?.objectTypeId)
  )

  void [ancestorNames, descendantNames, descendantTypeIds]
}
void folderRowAssertions
