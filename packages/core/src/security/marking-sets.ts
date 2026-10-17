/**
 * Shared, immutable sets of marking ids.
 *
 * Every column of every resolved version holds one of a handful of distinct sets, so each distinct
 * set is created once and compared by identity.
 */
export class MarkingSets {
  readonly empty: ReadonlySet<string> = new Set()
  private readonly sets = new Map<string, ReadonlySet<string>>([["", this.empty]])

  of(markingIds: Iterable<string> | undefined): ReadonlySet<string> {
    // Most columns carry no marking.
    if (markingIds === undefined || (Array.isArray(markingIds) && markingIds.length === 0)) {
      return this.empty
    }

    const sorted = [...new Set(markingIds)].sort()
    const key = sorted.join("\u0000")

    let set = this.sets.get(key)
    if (!set) {
      set = new Set(sorted)
      this.sets.set(key, set)
    }

    return set
  }

  /** The union of sets this instance created. */
  union(sets: Iterable<ReadonlySet<string> | undefined>): ReadonlySet<string> {
    let single: ReadonlySet<string> | undefined
    const ids: string[] = []

    for (const set of sets) {
      if (!set || set.size === 0) continue
      single = single === undefined && ids.length === 0 ? set : undefined
      ids.push(...set)
    }

    return single ?? this.of(ids)
  }
}
