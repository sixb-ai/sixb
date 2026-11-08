interface ScheduledWork {
  readonly properties: { readonly status: string; readonly scheduledStart?: string | Date }
}

/**
 * What a technician is on now, from their open work: what is already under way, else the soonest
 * scheduled. The roster and the technician's page both ask this, so they always agree.
 */
export function currentWork<TWork extends ScheduledWork>(
  openWork: readonly TWork[],
  underWay: ReadonlySet<string>
): TWork | undefined {
  return [...openWork].sort(
    (left, right) =>
      Number(underWay.has(right.properties.status)) -
        Number(underWay.has(left.properties.status)) || startOf(left) - startOf(right)
  )[0]
}

function startOf(work: ScheduledWork): number {
  const start = work.properties.scheduledStart
  return start ? new Date(start).getTime() : Number.POSITIVE_INFINITY
}
