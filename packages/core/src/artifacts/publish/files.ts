import { statFileRef } from "../../blob-storage/file-content"
import type { BlobStorage } from "../../blob-storage/types"
import { isValidFileRef } from "../../blob-storage/validation"
import type { ArtifactFile } from "../../storage/artifacts/types"
import { ArtifactRequestError } from "../errors"
import type { ArtifactKind } from "../kinds"
import { ARTIFACT_LIMITS, artifactSizeLimits } from "../limits"

export type ArtifactBlobStorage = Pick<BlobStorage, "stat" | "open">

/**
 * Checks a version's files before anything reads them: safe unique paths, the limits of its kind,
 * and stored bytes that match each reference.
 */
export async function checkArtifactFiles(
  blobStorage: ArtifactBlobStorage,
  kind: ArtifactKind,
  files: readonly ArtifactFile[]
): Promise<void> {
  if (files.length === 0) throw invalidArtifact("A version needs at least one file.")
  if (files.length > ARTIFACT_LIMITS.maxFiles) {
    throw invalidArtifact(
      `A version holds at most ${ARTIFACT_LIMITS.maxFiles} files; this one has ${files.length}.`
    )
  }

  const { maxFileBytes, maxVersionBytes } = artifactSizeLimits(kind)
  const paths = new Set<string>()
  let totalBytes = 0
  for (const entry of files) {
    if (!isArtifactPath(entry.path)) {
      throw invalidArtifact(
        `'${entry.path}' is not a usable file path: use a relative path with / separators, no . or .. segments, and at most ${ARTIFACT_LIMITS.maxPathLength} characters.`
      )
    }
    if (paths.has(entry.path)) throw invalidArtifact(`'${entry.path}' appears twice.`)
    paths.add(entry.path)
    if (!isValidFileRef(entry.file)) {
      throw invalidArtifact(`'${entry.path}' does not have a valid file reference.`)
    }
    if (entry.file.sizeBytes > maxFileBytes) {
      throw invalidArtifact(
        `'${entry.path}' is ${entry.file.sizeBytes} bytes; in a ${kind} artifact, a file may be at most ${maxFileBytes}.`
      )
    }
    totalBytes += entry.file.sizeBytes
  }
  if (totalBytes > maxVersionBytes) {
    throw invalidArtifact(
      `The files total ${totalBytes} bytes; a version of a ${kind} artifact may hold at most ${maxVersionBytes}.`
    )
  }

  const stored = await Promise.all(files.map((entry) => statFileRef(blobStorage, entry.file)))
  const missing = files.find((_, index) => !stored[index])
  if (missing) throw invalidArtifact(`'${missing.path}' refers to a file that is not stored.`)
}

/** The file at `path`, read as UTF-8 text when it is no larger than `maxBytes`. */
export async function readArtifactText(
  blobStorage: ArtifactBlobStorage,
  file: ArtifactFile,
  maxBytes: number
): Promise<string> {
  if (file.file.sizeBytes > maxBytes) {
    throw invalidArtifact(
      `'${file.path}' is ${file.file.sizeBytes} bytes; it may be at most ${maxBytes}.`
    )
  }
  const text = await new Response(await blobStorage.open(file.file.blobId)).text()
  // A byte-order mark is not part of the text.
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

/** Relative, `/`-separated, no empty, `.`, or `..` segment, no backslash or control character. */
export function isArtifactPath(path: string): boolean {
  return (
    typeof path === "string" &&
    path.length > 0 &&
    path.length <= ARTIFACT_LIMITS.maxPathLength &&
    !path.startsWith("/") &&
    !path.includes("\\") &&
    !/[\u0000-\u001f\u007f]/.test(path) &&
    path.split("/").every((segment) => segment.length > 0 && segment !== "." && segment !== "..")
  )
}

/** A title as a file name: what one may not hold, and each run of spaces, one space. */
export function titleFileName(title: string, fallback: string): string {
  const name = [...title]
    .map((char) => (char < " " || '\\/:*?"<>|'.includes(char) ? " " : char))
    .join("")
    .replace(/\s+/g, " ")
    .trim()
  return name || fallback
}

export function invalidArtifact(message: string): ArtifactRequestError {
  return new ArtifactRequestError("invalid_artifact", `[Sixb] ${message}`)
}
