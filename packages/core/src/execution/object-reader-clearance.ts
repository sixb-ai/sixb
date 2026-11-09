import { type PropertyClearance, resolvePropertyClearance } from "../objects/property-clearance"
import type { OntologyRegistry } from "../ontology"
import type { AppliedMarkings } from "../security/applied-markings"
import type { EventOriginRef } from "../security/applied-markings-contribution"
import type { AppliedMarkingsSnapshot } from "../security/applied-markings-snapshot"

/** What one read may not return; `undefined` when it reads everything. */
export type Clearance = PropertyClearance | undefined

/**
 * What one authority cannot read: the markings the code declares, and those the dataset versions
 * projections applied add, for an authority they can affect.
 *
 * A reader they cannot affect, trusted code included, gets the code's clearance as a plain value:
 * awaiting it costs one microtask, not a refresh. Otherwise the clearance is resolved for each
 * snapshot, which rarely changes, so the last one is kept.
 */
export class ObjectReaderClearance {
  readonly #ontology: OntologyRegistry
  /** What the authority cannot read under the code's markings; absent when it reads everything. */
  readonly #static: Clearance
  /** The authority's clearances; absent when it is unrestricted. */
  readonly #clearances?: ReadonlySet<string>
  /** Present only when applied dataset versions can deny this authority more than the code. */
  readonly #applied?: AppliedMarkings
  #lastSnapshot?: AppliedMarkingsSnapshot
  #lastClearance: Clearance

  constructor(input: {
    readonly ontology: OntologyRegistry
    readonly clearances: ReadonlySet<string> | undefined
    readonly appliedMarkings?: AppliedMarkings
  }) {
    this.#ontology = input.ontology
    this.#clearances = input.clearances
    this.#static = input.clearances && resolvePropertyClearance(input.ontology, input.clearances)

    if (input.clearances && input.appliedMarkings?.affects(input.clearances)) {
      this.#applied = input.appliedMarkings
    }

    Object.freeze(this)
  }

  /** What the authority cannot read now. */
  current(): Clearance | Promise<Clearance> {
    const applied = this.#applied
    const clearances = this.#clearances
    if (!applied || !clearances) return this.#static

    return applied.current().then((snapshot) => {
      if (snapshot !== this.#lastSnapshot) {
        this.#lastClearance = resolvePropertyClearance(this.#ontology, clearances, snapshot)
        this.#lastSnapshot = snapshot
      }
      return this.#lastClearance
    })
  }

  /**
   * This clearance as it is now, for a reader that must not read the project's storage, such as
   * one inside a storage transaction: what applied dataset versions add is read once, here, and
   * kept. A clearance they cannot affect reads nothing and is returned as it is.
   */
  async pinned(): Promise<ObjectReaderClearance> {
    const applied = this.#applied
    if (!applied) return this

    const snapshot = await applied.current()
    return new ObjectReaderClearance({
      ontology: this.#ontology,
      clearances: this.#clearances,
      appliedMarkings: pinnedAppliedMarkings(applied, snapshot),
    })
  }

  /**
   * What the authority cannot read in an object event. Reads the event's origin version only for
   * an authority its markings affect.
   */
  forEvent(sources: EventSources): Clearance | Promise<Clearance> {
    const applied = this.#applied
    const clearances = this.#clearances
    if (!applied || !clearances) return this.#static

    return applied
      .current()
      .then((snapshot) =>
        sources.origin ? applied.forEventOrigin(snapshot, sources.origin) : snapshot
      )
      .then((snapshot) =>
        sources.earlier ? applied.forEarlierValues(snapshot, sources.objectTypeId) : snapshot
      )
      .then((snapshot) => resolvePropertyClearance(this.#ontology, clearances, snapshot))
  }
}

/** Applied markings that answer `snapshot` as current, and never refresh it. */
function pinnedAppliedMarkings(
  applied: AppliedMarkings,
  snapshot: AppliedMarkingsSnapshot
): AppliedMarkings {
  return {
    affects: (clearances) => applied.affects(clearances),
    current: async () => snapshot,
    invalidate: () => {},
    forEventOrigin: (current, origin) => applied.forEventOrigin(current, origin),
    forEarlierValues: (current, objectTypeId) => applied.forEarlierValues(current, objectTypeId),
  }
}

/** Where the values of an object event came from. */
export interface EventSources {
  readonly objectTypeId: string
  /** The projection that emitted the event, and the version it applied. */
  readonly origin?: EventOriginRef
  /**
   * Whether the event holds values from before it, which came from versions applied earlier: an
   * update or a deletion, or a record an action or a direct write took of projected values.
   */
  readonly earlier: boolean
}
