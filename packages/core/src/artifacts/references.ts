/** An `artifact:` address a version uses, recorded when the version is published. */
export interface ArtifactReference {
  /** The address as written, such as `artifact:art_k3m9q2x7tp#chart=revenue`. */
  readonly address: string
  /** An embed shows the target in place; a link opens it. */
  readonly as: "embed" | "link"
  /** Where the address sits in its host: a heading slug, a slide number, or a sheet cell. */
  readonly at: string
  /** The target's version when this version was published, so later changes can be told apart. */
  readonly resolvedVersion: number
}
