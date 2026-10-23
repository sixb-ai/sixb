/**
 * Expanded user properties on registry-resolved rows: an array at the root, and a property of one
 * member of a polymorphic id-only target, which only that member's rows carry. The browser and the
 * server type the query identically.
 */
import { objects } from "@sixb/client/query"
import type { Sixb, UserProfile } from "@sixb/core"
import { StressProject, StressTeam, StressUser } from "./ontology/stress"

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false
type Expect<T extends true> = T
type RowOf<TBuilt> = TBuilt extends { first(): Promise<infer TRow> } ? NonNullable<TRow> : never

declare const sixb: Sixb

const onServer = sixb
  .objects(StressProject)
  .query()
  .expand(StressProject.p.watchers)
  .expand(StressProject.l.owner, (owner) =>
    owner.expand(StressTeam.p.lead).expand(StressTeam.l.members, { limit: 10 })
  )
const inBrowser = objects(StressProject)
  .query()
  .expand(StressProject.p.watchers)
  .expand(StressProject.l.owner, (owner) =>
    owner.expand(StressTeam.p.lead).expand(StressTeam.l.members, { limit: 10 })
  )
type _sameQuery = Expect<Equal<typeof inBrowser, typeof onServer>>

type ProjectRow = RowOf<typeof inBrowser>
type _watchers = Expect<Equal<ProjectRow["users"]["watchers"], UserProfile[] | undefined>>

function projectRowAssertions(rows: ProjectRow[]): void {
  const watcherEmails: string[] = rows.flatMap((project) =>
    (project.users.watchers ?? []).map((watcher) => watcher.email)
  )

  const leadNames: (string | undefined)[] = rows.map((project) => {
    const owner = project.links.owner
    if (owner?.objectTypeId !== "StressTeam") return undefined

    const memberEmails: string[] = owner.links.members.map((member) => member.properties.email)
    void memberEmails
    return owner.users.lead?.displayName
  })

  const owner = rows[0]?.links.owner
  if (owner?.objectTypeId === "StressUser") {
    // @ts-expect-error — `lead` is a Team property, so User rows carry no `users`.
    void owner.users
  }

  void [watcherEmails, leadNames]
}
void projectRowAssertions

// @ts-expect-error — `email` is not a ref.user() property.
sixb.objects(StressUser).query().expand(StressUser.p.email)
