import {
  type GetArtifactQueryResponse,
  type GetArtifactVersionResponse,
  getArtifactQuery,
  isSixbApiError,
} from "@sixb/client"
import { events, useEvents } from "@sixb/client/hooks"
import {
  ARTIFACT_THEME_FILE,
  type ArtifactTheme,
  artifactQueryName,
  parseArtifactTheme,
} from "@sixb/core/artifacts"
import {
  type QueryClient,
  queryOptions,
  useIsFetching,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query"
import { useCallback, useMemo, useSyncExternalStore } from "react"
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
  return [...versionQueriesKey({ artifactId, version }), name] as const
}

/** Where every query result of a version is cached, one key under it each. */
export function versionQueriesKey(version: QueriedVersion) {
  return [ARTIFACT_QUERIES, version.artifactId, version.version] as const
}

const ARTIFACT_QUERIES = "artifact-query"

/** The version a query runs at: the one the view or the frame shows. */
export type QueriedVersion = Pick<ArtifactVersion, "artifactId" | "version">

/** Read once a view shows it, and again when one opens after half a minute, as page state is. */
const QUERY_STALE_MS = 30_000

/**
 * How one of a version's queries is read and cached, by every view that reads it: a live sheet, a
 * page's frame, a download.
 */
export function artifactQueryOptions(version: QueriedVersion, name: string) {
  return queryOptions({
    queryKey: artifactQueryKey(version.artifactId, version.version, name),
    staleTime: QUERY_STALE_MS,
    retry: false,
    queryFn: ({ signal }) => readQuery(version, name, signal),
  })
}

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
  const query = useQuery({ ...artifactQueryOptions(version, name ?? ""), enabled: name !== null })
  useArtifactQueryLiveUpdates(name !== null)

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
  return client.fetchQuery(artifactQueryOptions(version, name))
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

/** Whether a version holds queries: what it shows is read live, as each reader opens it. */
export function holdsQueries(version: Pick<ArtifactVersion, "files">): boolean {
  return version.files.some((file) => artifactQueryName(file.path) !== undefined)
}

/**
 * The version's queries the reader has read, as the header shows them: when the last read came in,
 * none until one has, whether one is being read, and `refresh`, which reads every one again. The
 * views that show one refetch it, and a frame's page hears its rows changed; one no view shows is
 * read when one opens.
 */
export function useVersionQueries(version: QueriedVersion): {
  readonly readAt: number | null
  readonly refreshing: boolean
  readonly refresh: () => void
} {
  const queries = useQueryClient()
  const { artifactId, version: number } = version

  const subscribe = useCallback(
    (onChange: () => void) => queries.getQueryCache().subscribe(onChange),
    [queries]
  )
  const readAt = useSyncExternalStore(subscribe, () =>
    lastRead(queries, versionQueriesKey({ artifactId, version: number }))
  )
  const refreshing = useIsFetching({ queryKey: versionQueriesKey(version) }) > 0

  const refresh = useCallback(() => {
    void queries.invalidateQueries({ queryKey: versionQueriesKey({ artifactId, version: number }) })
  }, [queries, artifactId, number])

  return { readAt, refreshing, refresh }
}

function lastRead(queries: QueryClient, key: readonly unknown[]): number | null {
  let last = 0
  for (const query of queries.getQueryCache().findAll({ queryKey: key })) {
    if (query.state.data !== undefined) last = Math.max(last, query.state.dataUpdatedAt)
  }
  return last > 0 ? last : null
}

/** A sync writes in bursts: what changes within a second reads each query again once. */
export const LIVE_QUERY_DEBOUNCE_MS = 1_000

/**
 * Reads the cached queries again when the objects they read change, while `enabled`: every view
 * that observes one mounts it, a live sheet or a frame whose page read one, so a reader with no
 * live artifact open subscribes to nothing. The app's event provider puts every view's
 * subscription on one socket.
 *
 * Object events name their type, link events their source's and target's. A query is read again
 * when its result's `readObjectTypeIds` holds one of them: every type it reads, filtered on,
 * expanded or counted. The views that show it refetch it; one no view shows is only marked stale.
 */
export function useArtifactQueryLiveUpdates(enabled: boolean): void {
  const queries = useQueryClient()

  useEvents(events.objects(), (event) => changed(queries, [event.payload.objectTypeId]), {
    enabled,
  })
  useEvents(
    events.links(),
    (event) => changed(queries, [event.payload.sourceTypeId, event.payload.targetTypeId]),
    { enabled }
  )
}

/**
 * The types changed since the first event of the second, for each cache. Kept here, not in each
 * view: every view that observes a query hears the same event, and a query read again once per
 * view would cancel the read before it each time.
 */
const changes = new WeakMap<QueryClient, Set<string>>()

function changed(queries: QueryClient, types: readonly string[]): void {
  let pending = changes.get(queries)
  if (!pending) {
    pending = new Set()
    changes.set(queries, pending)
    setTimeout(() => readAgain(queries), LIVE_QUERY_DEBOUNCE_MS)
  }

  for (const type of types) pending.add(type)
}

function readAgain(queries: QueryClient): void {
  const types = changes.get(queries)
  changes.delete(queries)
  if (!types) return

  void queries.invalidateQueries({
    queryKey: [ARTIFACT_QUERIES],
    predicate: (query) => {
      const result = query.state.data as GetArtifactQueryResponse | undefined
      return result?.readObjectTypeIds.some((type) => types.has(type)) ?? false
    },
  })
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
