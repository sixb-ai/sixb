import type { SixbRuntimeContext } from "../runtime/types"
import type { ActivityActor, ActivityVisit } from "../storage/activity/types"
import type { ShareGrantRecord } from "../storage/share-grants"

/** Who a visit belongs to, as `sixb.activity` returns it: a shared link also names its share. */
export type ActivityVisitActor =
  | Extract<ActivityActor, { readonly type: "user" }>
  | (Extract<ActivityActor, { readonly type: "share" }> & {
      /** The link's share definition; absent once its grant is gone. */
      readonly definitionId?: string
    })

/** A visit as `sixb.activity` returns it. */
export interface ActivityVisitView extends Omit<ActivityVisit, "actor"> {
  readonly actor: ActivityVisitActor
}

/** Visits named by their links' shares, from one grant read for all of them. */
export async function nameSharedVisits(
  runtime: SixbRuntimeContext,
  visits: readonly ActivityVisit[]
): Promise<readonly ActivityVisitView[]> {
  const grants = await readGrants(runtime, visits)
  return visits.map((visit) => withShare(visit, grants))
}

/** One visit named by its link's share, with that link's grant when it still exists. */
export async function nameSharedVisit(
  runtime: SixbRuntimeContext,
  visit: ActivityVisit
): Promise<{ readonly visit: ActivityVisitView; readonly grant?: ShareGrantRecord }> {
  const grants = await readGrants(runtime, [visit])
  const grant = visit.actor.type === "share" ? grants.get(visit.actor.grantId) : undefined

  return { visit: withShare(visit, grants), ...(grant === undefined ? {} : { grant }) }
}

async function readGrants(
  runtime: SixbRuntimeContext,
  visits: readonly ActivityVisit[]
): Promise<ReadonlyMap<string, ShareGrantRecord>> {
  const ids = visits.flatMap((visit) => (visit.actor.type === "share" ? [visit.actor.grantId] : []))
  if (ids.length === 0 || !runtime.storage.shareGrants) {
    return new Map()
  }

  const grants = await runtime.storage.shareGrants.getByIds({ projectId: runtime.projectId, ids })
  return new Map(grants.map((grant) => [grant.id, grant]))
}

function withShare(
  visit: ActivityVisit,
  grants: ReadonlyMap<string, ShareGrantRecord>
): ActivityVisitView {
  const { actor } = visit
  const grant = actor.type === "share" ? grants.get(actor.grantId) : undefined
  if (actor.type !== "share" || grant === undefined) {
    return visit
  }

  return { ...visit, actor: { ...actor, definitionId: grant.definitionId } }
}
