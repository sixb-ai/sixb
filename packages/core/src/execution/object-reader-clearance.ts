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
   * What the authority cannot read in an object event a projection emitted, which holds the
   * values of its origin version. Reads that version only for an authority its markings affect.
   */
  forEventOrigin(origin: EventOriginRef): Clearance | Promise<Clearance> {
    const applied = this.#applied
    const clearances = this.#clearances
    if (!applied || !clearances) return this.#static

    return applied
      .current()
      .then((snapshot) => applied.forEventOrigin(snapshot, origin))
      .then((snapshot) => resolvePropertyClearance(this.#ontology, clearances, snapshot))
  }
}
