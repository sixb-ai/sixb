import type { DatasetDefinition } from "../datasets/types"
import { isUnknownLineage, lineageColumn, versionLineage } from "../lake-storage/lineage"
import type { DatasetColumnRef, DatasetVersion } from "../lake-storage/types"
import { MarkingSets } from "./marking-sets"

/** Markings of each column of one dataset version. A column without markings has an empty set. */
export type VersionColumnMarkings = ReadonlyMap<string, ReadonlySet<string>>

export interface VersionClassification {
  readonly columns: VersionColumnMarkings
  /**
   * Why part of the version was classified conservatively, with every marking it could hold.
   * Absent when every column was classified from its lineage.
   */
  readonly conservative?: string
}

/**
 * Markings each version of a dataset carries.
 *
 * Markings are never stored. A column carries the markings its registered dataset declares, and
 * those every column its lineage lists declares. The version records that lineage resolved across
 * every upstream step and every row it keeps (`DatasetVersion.lineage`), so a version keeps the
 * classification of the code that produced it, and classifying it reads no other version.
 *
 * Wherever the record does not say what a column holds (no lineage on a pipeline version, an
 * unknown history, a column it does not list, a dataset no longer registered) the column is
 * classified with every marking the project declares.
 */
export interface DatasetVersionMarkings {
  classify(version: DatasetVersion): VersionClassification
  /**
   * Every marking declared on a registered column. Every classification, conservative ones
   * included, is drawn from it, so a reader cleared for all of it needs no classification. Empty
   * when the project declares no column markings.
   */
  everyMarking(): ReadonlySet<string>
}

export interface DatasetVersionMarkingsOptions {
  readonly datasets: { list(): readonly DatasetDefinition[] }
}

export function createDatasetVersionMarkings(
  options: DatasetVersionMarkingsOptions
): DatasetVersionMarkings {
  const sets = new MarkingSets()
  // Built on first use: a host that never classifies a version pays nothing for it.
  let declared: ReadonlyMap<string, ReadonlyMap<string, ReadonlySet<string>>> | undefined
  const declaredByDataset = () =>
    (declared ??= new Map(
      options.datasets
        .list()
        .map((dataset) => [
          dataset.id,
          new Map(dataset.schema.columns.map((column) => [column.name, sets.of(column.markings)])),
        ])
    ))
  /**
   * Every marking a registered column declares: what a column may hold where its record does not
   * say. The pipelines that wrote it may have read datasets the current code no longer reads, so
   * nothing narrower is safe.
   */
  let every: ReadonlySet<string> | undefined
  const everyMarking = () =>
    (every ??= sets.union(
      [...declaredByDataset().values()].flatMap((columns) => [...columns.values()])
    ))

  const classify = (version: DatasetVersion): VersionClassification => {
    const subject = `version '${version.versionId}' of '${version.datasetId}'`
    const own = declaredByDataset().get(version.datasetId)
    // No definition says what its columns declare: they may hold anything a column declares.
    if (!own) return conservatively(version, `dataset '${version.datasetId}' is not registered`)
    const lineage = versionLineage(version)
    if (isUnknownLineage(lineage)) {
      // A reason core derived names this version. A recorded one names where the lineage was
      // lost: upstream, or, for a provider that could not decode it, this version's own record.
      return conservatively(
        version,
        lineage === version.lineage
          ? `the lineage of ${subject} is unknown: ${lineage.unknown}`
          : lineage.unknown
      )
    }

    let conservative: string | undefined
    const markingsOf = (ref: DatasetColumnRef): ReadonlySet<string> | undefined => {
      const columns = declaredByDataset().get(ref.datasetId)
      if (columns) return columns.get(ref.column)
      conservative ??= `dataset '${ref.datasetId}' is not registered`
      return everyMarking()
    }
    const rows = sets.union(lineage.rows.map(markingsOf))
    const columns = new Map(
      version.schema.columns.map(({ name }) => {
        const values = lineageColumn(lineage, name)
        if (!values) {
          conservative ??= `${subject} recorded no lineage for column '${name}'`
          return [name, everyMarking()]
        }
        return [name, sets.union([own.get(name), rows, ...values.map(markingsOf)])]
      })
    )
    return { columns, ...(conservative === undefined ? {} : { conservative }) }
  }

  const conservatively = (version: DatasetVersion, reason: string): VersionClassification => {
    const markings = everyMarking()
    return {
      columns: new Map(version.schema.columns.map(({ name }) => [name, markings])),
      conservative: reason,
    }
  }

  return { classify, everyMarking }
}

// ── Host capability ─────────────────────────────────────────

const datasetVersionMarkingsKey: unique symbol = Symbol("sixb.datasetVersionMarkings")

interface DatasetVersionMarkingsOwner {
  readonly [datasetVersionMarkingsKey]?: DatasetVersionMarkings
}

/** One classifier per host, so every reader shares the markings it reads from the definitions. */
export function registerDatasetVersionMarkings(
  owner: object,
  markings: DatasetVersionMarkings
): void {
  const registered = (owner as DatasetVersionMarkingsOwner)[datasetVersionMarkingsKey]
  if (registered && registered !== markings) {
    throw new Error("[Sixb] Dataset version markings are already registered for this owner.")
  }
  Object.defineProperty(owner, datasetVersionMarkingsKey, {
    configurable: false,
    enumerable: false,
    value: markings,
    writable: false,
  })
}

export function getDatasetVersionMarkings(owner: object): DatasetVersionMarkings {
  const markings = (owner as DatasetVersionMarkingsOwner)[datasetVersionMarkingsKey]
  if (markings) return markings
  throw new Error("[Sixb] Dataset version markings are not registered for this runtime.")
}

export function shareDatasetVersionMarkings(source: object, target: object): void {
  registerDatasetVersionMarkings(target, getDatasetVersionMarkings(source))
}
