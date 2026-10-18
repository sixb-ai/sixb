import type { GetArtifactVersionResponse } from "@sixb/client"
import { getArtifactVersionQueryKey } from "@sixb/client/hooks"
import type { QueryClient } from "@tanstack/react-query"
import { artifactFileSource } from "../../src/artifacts/file-source"
import { fileTextQueryKey } from "../../src/artifacts/queries"

type VersionFiles = GetArtifactVersionResponse["files"]

/**
 * A version's files for these texts, each sized by its text: a CSV is `text/csv`, the rest plain
 * text. `seed` keeps blob ids apart between artifacts.
 */
export function textFiles(texts: Readonly<Record<string, string>>, seed = "file"): VersionFiles {
  return Object.entries(texts).map(([path, text], index) => ({
    path,
    file: {
      blobId: `${seed}-${index}`,
      digest: `sha256:${String(index).padStart(64, "0")}`,
      sizeBytes: text.length,
      mediaType: path.endsWith(".csv") ? "text/csv" : "text/plain",
    },
  }))
}

/** A published version, with what a test leaves out filled in. */
export function artifactVersion(
  version: Pick<GetArtifactVersionResponse, "artifactId" | "title" | "entry" | "outline"> &
    Partial<GetArtifactVersionResponse>
): GetArtifactVersionResponse {
  return {
    version: 1,
    files: [],
    references: [],
    author: { type: "user", id: "user-1" },
    createdAt: "2026-10-02T12:00:00.000Z",
    ...version,
  }
}

/**
 * Puts a version in the cache, under its number or `as` (such as `"latest"`), and each text where
 * the viewer reads that file's text, so nothing is fetched.
 */
export function seedVersion(
  cache: QueryClient,
  version: GetArtifactVersionResponse,
  texts: Readonly<Record<string, string>> = {},
  options: { readonly as?: string } = {}
): void {
  cache.setQueryData(
    getArtifactVersionQueryKey({
      path: { artifactId: version.artifactId, version: options.as ?? String(version.version) },
    }),
    version
  )
  for (const [path, text] of Object.entries(texts)) {
    cache.setQueryData(fileTextKey(version, path), text)
  }
}

/** Leaves a version's file as one whose text could not be read. */
export function failFileText(
  cache: QueryClient,
  version: GetArtifactVersionResponse,
  path: string
): void {
  cache
    .getQueryCache()
    .build(cache, { queryKey: fileTextKey(version, path) })
    .setState({ status: "error", error: new Error("[SixbAppTest] The file could not be read.") })
}

/** The key `useFileText` reads a file's text under. */
function fileTextKey(version: GetArtifactVersionResponse, path: string): readonly unknown[] {
  const file = version.files.find((candidate) => candidate.path === path)
  if (!file) throw new Error(`[SixbAppTest] Version ${version.version} has no file at ${path}.`)
  const source = artifactFileSource({
    artifactId: version.artifactId,
    version: version.version,
    path,
    fileRef: file.file,
  })
  return fileTextQueryKey(source)
}
