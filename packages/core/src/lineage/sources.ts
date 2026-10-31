import type { OntologyObjectRef } from "../materialization/model"
import type {
  OntologyCommitRecord,
  StoredSourceLinkAssertion,
  StoredSourceObjectAssertion,
} from "../storage/ontology"
import {
  attributeCommits,
  type CommitAttribution,
  commitsById,
  type EditCommitRecord,
  type EditedChange,
  editCommitFor,
  editCommitsAt,
  editSource,
  telemetrySource,
} from "./commits"
import {
  type DescribedProjection,
  describeProjection,
  type LineageDependencies,
} from "./projections"
import type { LineageReader } from "./reader"
import type { LineageSource } from "./types"

/**
 * How the commit behind an edit is found:
 * - `at`: among the edit commits made at its edit time, by the change it made;
 * - `named`: exactly, as a link override names the commit that last wrote it;
 * - `unknown`: not at all, for an edit recorded without its time; cited at the override's time.
 */
export type EditLookup =
  | { readonly kind: "at"; readonly instant: string; readonly change: EditedChange }
  | { readonly kind: "named"; readonly commitId: string }
  | { readonly kind: "unknown"; readonly instant: string }

/** The commits one lineage cites, gathered before any is read so each is read once. */
export class LineageCommitReads {
  readonly instants = new Set<string>()
  readonly commitIds = new Set<string>()

  edit(lookup: EditLookup): void {
    if (lookup.kind === "at") this.instants.add(lookup.instant)
    if (lookup.kind === "named") this.commitIds.add(lookup.commitId)
  }

  telemetry(commitId: string): void {
    this.commitIds.add(commitId)
  }
}

/**
 * The facts one lineage reads, and the sources it cites from them. Each source is described once,
 * under its key, in the order it is first cited.
 */
export class LineageSources {
  readonly #cited: Record<string, LineageSource> = {}

  private constructor(
    readonly projection: DescribedProjection | null,
    private readonly object: OntologyObjectRef,
    private readonly commitsAt: ReadonlyMap<string, readonly EditCommitRecord[]>,
    private readonly commitsNamed: ReadonlyMap<string, OntologyCommitRecord>,
    private readonly attributions: ReadonlyMap<string, CommitAttribution>
  ) {}

  /**
   * Read the projection behind `stored` and the commits `reads` gathered, together. `object` is
   * the object whose edits are found by their time.
   */
  static async read(input: {
    readonly reader: LineageReader
    readonly dependencies: LineageDependencies
    readonly object: OntologyObjectRef
    readonly stored: StoredSourceObjectAssertion | StoredSourceLinkAssertion | null
    readonly reads: LineageCommitReads
  }): Promise<LineageSources> {
    const { reader, dependencies, object, stored, reads } = input

    const [projection, commitsAt, commitsNamed] = await Promise.all([
      stored ? describeProjection(reader, dependencies, stored) : null,
      editCommitsAt(reader, reads.instants),
      commitsById(reader, reads.commitIds),
    ])

    const commits = [...[...commitsAt.values()].flat(), ...commitsNamed.values()]
    const attributions = await attributeCommits(reader, dependencies.projections, commits)

    return new LineageSources(projection, object, commitsAt, commitsNamed, attributions)
  }

  get cited(): Readonly<Record<string, LineageSource>> {
    return this.#cited
  }

  /** The projection whose source row decided a value. */
  citeProjection(): string {
    const projection = this.projection
    if (!projection) throw new Error("[Sixb] Lineage cites a source row it did not read.")

    return this.#cite(projection.key, () => projection.source)
  }

  /** The edit behind a value: its commit, or the instant it was made at when that is unknown. */
  citeEdit(lookup: EditLookup): string {
    switch (lookup.kind) {
      case "named":
        return this.#citeEditCommit(this.#named(lookup.commitId))

      case "at": {
        const commits = this.commitsAt.get(lookup.instant) ?? []
        const commit = editCommitFor(commits, this.object, lookup.change)
        return commit ? this.#citeEditCommit(commit) : this.#citeUnknownEdit(lookup.instant)
      }

      case "unknown":
        return this.#citeUnknownEdit(lookup.instant)
    }
  }

  citeTelemetry(commitId: string): string {
    const commit = this.#named(commitId)
    return this.#cite(`telemetry:${commit.id}`, () =>
      telemetrySource(commit, this.attributions.get(commit.id)!)
    )
  }

  citeIdentity(): string {
    return this.#cite("identity", () => ({ kind: "identity" }))
  }

  #citeEditCommit(commit: OntologyCommitRecord): string {
    return this.#cite(`commit:${commit.id}`, () =>
      editSource(commit, this.attributions.get(commit.id)!)
    )
  }

  #citeUnknownEdit(instant: string): string {
    return this.#cite(`commit@${instant}`, () => ({
      kind: "edit",
      commitId: null,
      committedAt: instant,
    }))
  }

  #cite(key: string, describe: () => LineageSource): string {
    this.#cited[key] ??= describe()
    return key
  }

  #named(commitId: string): OntologyCommitRecord {
    const commit = this.commitsNamed.get(commitId)
    if (!commit) throw new Error(`[Sixb] Lineage cites commit '${commitId}' it did not read.`)
    return commit
  }
}
