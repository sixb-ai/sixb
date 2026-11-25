import type { DatasetProducer, DatasetVersion, DatasetVersionRef } from "./types"

/**
 * A lake a branch can read in place. Production cuts a slice of its catalog that holds only some
 * dataset versions, as of one point in its history, and serves the files those versions read. The
 * branch attaches the slice as its own catalog: it reads production's files, never writes them,
 * and never holds production's catalog or storage credentials.
 *
 * What the files of a slice hold is the boundary: a branch can read them whole, so they hold no
 * row its versions do not return. A file part of whose rows a version deleted is served as a copy
 * without them.
 *
 * Optional: a provider without it cannot be branched from.
 */
export interface LakeForks {
  /**
   * The lake's position now: the point a branch is cut at. Opaque; it orders like the lake's
   * commits. Take it after the snapshot of the objects began, so that every version an object
   * was derived from is at or before it.
   */
  currentPoint(): Promise<string>

  /**
   * Each dataset's latest version at the point, schema changes included. Null for a dataset that
   * had no version yet, or that the lake does not hold.
   */
  versionsAt(input: LakeVersionsAtInput): Promise<ReadonlyMap<string, DatasetVersion | null>>

  /**
   * Writes a catalog that holds exactly these versions, one per dataset, cut at the point, to a
   * local file, from one consistent state of the lake. Metadata only, besides the rows the lake
   * keeps in its catalog and the copies of files whose rows the versions do not all return.
   * Nothing about any other dataset is written, and a version's commit says no more than the
   * slice's reader may see. Never blocks the lake's other reads and writes while it runs.
   *
   * It calls `record` with the exact files the slice serves before it writes any of them, and
   * returns them: the caller records the slice first, so nothing the cut writes is unrecorded.
   */
  writeSlice(input: WriteLakeSliceInput): Promise<ReadonlySet<string>>

  /**
   * One of the lake's files, by a path a slice serves. Null when there is none. Read-only: nothing
   * a fork does can change one of the lake's own files.
   */
  openFile(path: string): Promise<LakeFile | null>

  /**
   * Deletes the files slices made for themselves, such as copies, that no file list of
   * `liveSlices` names. Returns how many it deleted.
   */
  releaseFiles(input: ReleaseLakeSliceFilesInput): Promise<number>
}

/**
 * A lake that is a branch's slice of production's. Its versions up to the slice's point are
 * production's, read in place; the ones it commits are the branch's own, and their ids say so.
 */
export interface LakeFork {
  /** Whether a version is one the branch committed, not one of production's it reads. */
  ownsVersion(versionId: string): boolean
}

export interface LakeVersionsAtInput {
  readonly point: string
  readonly datasetIds: readonly string[]
}

/** A version a slice holds, with the producer its reader may see. */
export interface LakeSliceVersion extends DatasetVersionRef {
  /** Recorded as given; absent, the slice records no producer. */
  readonly producer?: DatasetProducer
}

export interface WriteLakeSliceInput {
  readonly point: string
  /** One version per dataset, each at or before the point. */
  readonly versions: readonly LakeSliceVersion[]
  /** A local file the slice is written to. It must not exist. */
  readonly path: string
  /** Called with the files the slice serves, before the cut writes any. */
  readonly record: (files: ReadonlySet<string>) => Promise<void>
}

export interface ReleaseLakeSliceFilesInput {
  /** The files of every slice a branch may still read. */
  readonly liveSlices: readonly (readonly string[])[]
}

/** An immutable file of the lake. */
export interface LakeFile {
  readonly sizeBytes: number
  /** Its bytes, or the ones from `start` to `endInclusive`. */
  read(range?: LakeFileRange): ReadableStream<Uint8Array>
}

export interface LakeFileRange {
  readonly start: number
  readonly endInclusive: number
}
