import type { GetArtifactVersionResponse } from "@sixb/client"
import { ARTIFACT_THEME_FILE, type ArtifactTheme, parseArtifactTheme } from "@sixb/core/artifacts"
import { useQuery } from "@tanstack/react-query"
import { useMemo } from "react"
import { artifactFileSource, type FileSource } from "./file-source"
import { type FileLoadError, fileLoadError, MAX_TEXT_PREVIEW_BYTES } from "./file-view"

export type ArtifactVersion = GetArtifactVersionResponse

/** A file's text, read whole when it is at most `maxBytes`: by default, what a preview reads. */
export function useFileText(
  source: FileSource | null,
  maxBytes: number = MAX_TEXT_PREVIEW_BYTES
): {
  readonly text: string | undefined
  readonly loading: boolean
  readonly error: FileLoadError | null
  readonly tooLarge: boolean
} {
  const tooLarge = source !== null && source.fileRef.sizeBytes > maxBytes
  const query = useQuery({
    queryKey: [...(source?.queryKey ?? ["no-file"]), "text"],
    enabled: source !== null && !tooLarge,
    // A version never changes, and a message file is stored once.
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
    queryFn: async ({ signal }) => {
      if (!source) throw new Error("[SixbApp] No file to read.")
      return (await source.load(signal)).text()
    },
  })
  return {
    text: query.data,
    loading: query.isLoading,
    error: query.error ? fileLoadError(query.error) : null,
    tooLarge,
  }
}

/** A file of a version, by its path in the artifact. */
export function versionFileSource(version: ArtifactVersion, path: string): FileSource | null {
  const file = version.files.find((candidate) => candidate.path === path)
  return file
    ? artifactFileSource({
        artifactId: version.artifactId,
        version: version.version,
        path: file.path,
        fileRef: file.file,
      })
    : null
}

/** The version's `theme.json`, when it has one that still reads. */
export function useArtifactTheme(version: ArtifactVersion): ArtifactTheme | null {
  const { text } = useFileText(versionFileSource(version, ARTIFACT_THEME_FILE))
  // One theme for as long as its text: a frame sends the theme again when it changes.
  return useMemo(() => {
    if (text === undefined) return null
    const parsed = parseArtifactTheme(text)
    return "theme" in parsed ? parsed.theme : null
  }, [text])
}

/** An image a document shows, by the relative path its Markdown names, resolved as publishing did. */
export function versionImageSource(version: ArtifactVersion, src: string): FileSource | null {
  const raw = src.split(/[?#]/)[0] ?? ""
  let decoded = raw
  try {
    decoded = decodeURI(raw)
  } catch {
    // Keep the path as written; it simply will not match a file.
  }
  const segments: string[] = []
  for (const segment of decoded.split("/")) {
    if (segment === "" || segment === ".") continue
    if (segment === "..") segments.pop()
    else segments.push(segment)
  }
  return versionFileSource(version, segments.join("/"))
}
