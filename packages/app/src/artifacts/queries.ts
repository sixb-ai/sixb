import {
  type GetArtifactQueryResponse,
  type GetArtifactVersionResponse,
  getArtifactQuery,
  isSixbApiError,
} from "@sixb/client"
import { ARTIFACT_THEME_FILE, type ArtifactTheme, parseArtifactTheme } from "@sixb/core/artifacts"
import { type QueryClient, useQuery } from "@tanstack/react-query"
import { useMemo } from "react"
import { artifactFileSource, type FileSource } from "./file-source"
import { type FileLoadError, fileLoadError, MAX_TEXT_PREVIEW_BYTES } from "./file-view"

export type ArtifactVersion = GetArtifactVersionResponse

/** Where a file's text is cached; a test seeds it there to render without a network. */
export function fileTextQueryKey(source: FileSource | null): readonly unknown[] {
  return [...(source?.queryKey ?? ["no-file"]), "text"]
}

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
    queryKey: fileTextQueryKey(source),
    enabled: source !== null && !tooLarge,
    // A version never changes, and a message file is stored once.
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
    queryFn: async ({ signal }) => {
      if (!source) throw new Error("[SixbApp] No file to read.")
      return readText(source, signal)
    },
  })
  return {
    text: query.data,
    loading: query.isLoading,
    error: query.error ? fileLoadError(query.error) : null,
    tooLarge,
  }
}

/**
 * A file's text through the cache {@link useFileText} fills, for work done outside a render, such
 * as building a download from files a reader has not opened.
 */
export function fetchFileText(client: QueryClient, source: FileSource): Promise<string> {
  return client.fetchQuery({
    queryKey: fileTextQueryKey(source),
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
    queryFn: ({ signal }) => readText(source, signal),
  })
}

async function readText(source: FileSource, signal: AbortSignal): Promise<string> {
  return (await source.load(signal)).text()
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

/** Where a version's query result is cached: every view of the version that shows it reads it once. */
export function artifactQueryKey(artifactId: string, version: number, name: string) {
  return ["artifact-query", artifactId, version, name] as const
}

/** The version a query runs at: the one the view or the frame shows. */
type QueriedVersion = Pick<ArtifactVersion, "artifactId" | "version">

/** Read once a view shows it, and again when one opens after half a minute, as page state is. */
const QUERY_STALE_MS = 30_000

/**
 * Why a query's rows could not be read: the reader cannot view what it reads, the project's data
 * no longer matches it, in the words the API gives, or the read failed.
 */
export type ArtifactQueryError =
  | { readonly kind: "forbidden" }
  | { readonly kind: "invalid"; readonly reason: string }
  | { readonly kind: "failed" }

/**
 * One of the version's queries, run as the signed-in reader: their rows, or why there are none to
 * show. `name` null reads nothing.
 */
export function useArtifactQuery(
  version: ArtifactVersion,
  name: string | null
): {
  readonly result: GetArtifactQueryResponse | undefined
  readonly loading: boolean
  readonly error: ArtifactQueryError | null
} {
  const query = useQuery({
    queryKey: artifactQueryKey(version.artifactId, version.version, name ?? ""),
    enabled: name !== null,
    staleTime: QUERY_STALE_MS,
    retry: false,
    queryFn: ({ signal }) => readQuery(version, name ?? "", signal),
  })

  return {
    result: query.data,
    loading: query.isLoading,
    error: query.error ? artifactQueryError(query.error) : null,
  }
}

/**
 * A query's rows through the cache {@link useArtifactQuery} fills, for work done outside a render,
 * such as a download of sheets the reader has not opened, or a page's `sixb.query` call.
 */
export function fetchArtifactQuery(
  client: QueryClient,
  version: QueriedVersion,
  name: string
): Promise<GetArtifactQueryResponse> {
  return client.fetchQuery({
    queryKey: artifactQueryKey(version.artifactId, version.version, name),
    staleTime: QUERY_STALE_MS,
    retry: false,
    queryFn: ({ signal }) => readQuery(version, name, signal),
  })
}

async function readQuery(
  version: QueriedVersion,
  name: string,
  signal: AbortSignal
): Promise<GetArtifactQueryResponse> {
  const { data } = await getArtifactQuery({
    path: { artifactId: version.artifactId, version: String(version.version), name },
    signal,
    throwOnError: true,
  })
  return data
}

function artifactQueryError(error: unknown): ArtifactQueryError {
  if (!isSixbApiError(error)) return { kind: "failed" }
  if (error.status === 403) return { kind: "forbidden" }

  const body = error.body as { readonly code?: unknown; readonly error?: unknown } | undefined
  if (error.status !== 409 || body?.code !== "query_invalid") return { kind: "failed" }

  // "[Sixb] Query 'overdue' no longer matches the ontology: $.predicate: …" says what changed.
  const message = typeof body.error === "string" ? body.error : ""
  return {
    kind: "invalid",
    reason: message.replace(/^\[Sixb\]\s*/, "").replace(/^Query '[^']*' [^:]*:\s*/, ""),
  }
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
