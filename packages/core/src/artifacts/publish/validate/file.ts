import { inferFileMediaType } from "../../../blob-storage/media-type"
import type { ArtifactFile } from "../../../storage/artifacts/types"
import type { FileOutline } from "../../outline"
import { invalidArtifact } from "../files"

/** A file artifact is one file of any type, delivered as it is. */
export function validateFileArtifact(files: readonly ArtifactFile[]): {
  readonly entry: string
  readonly outline: FileOutline
} {
  const [file] = files
  if (!file || files.length > 1) {
    throw invalidArtifact(`A file artifact holds exactly one file; this one has ${files.length}.`)
  }
  return {
    entry: file.path,
    outline: { kind: "file", mediaType: file.file.mediaType ?? inferFileMediaType(file.path) },
  }
}
