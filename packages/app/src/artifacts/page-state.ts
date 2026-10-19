import {
  clearArtifactState,
  deleteArtifactStateValue,
  getArtifactState,
  isSixbApiError,
  setArtifactState,
} from "@sixb/client"
import type { FrameCall } from "@sixb/core/artifacts"
import { type QueryClient, useQuery } from "@tanstack/react-query"

/** The reader's values for one artifact, by key, as the app last read or wrote them. */
type KeptValues = ReadonlyMap<string, unknown>

const stateKey = (artifactId: string) => ["artifact-state", artifactId] as const

/** Read once a frame asks, and again when a page opens after half a minute. */
const STATE_STALE_MS = 30_000

/**
 * Each artifact's calls, one after another: a slider that writes as it moves writes its values in
 * the order it moved, and a read after a write reads what was written.
 */
const queues = new Map<string, Promise<unknown>>()

/**
 * Answers a page's `sixb.state` call for the artifact its frame shows, as the signed-in reader:
 * reads come from the values read once, and each write goes to the API and then into them.
 */
export function answerStateCall(
  queries: QueryClient,
  artifactId: string,
  call: FrameCall
): Promise<unknown> {
  const previous = queues.get(artifactId) ?? Promise.resolve()
  const next = previous.then(
    () => runCall(queries, artifactId, call),
    () => runCall(queries, artifactId, call)
  )
  const settled = next.catch(() => {})
  queues.set(artifactId, settled)
  settled.then(() => {
    if (queues.get(artifactId) === settled) queues.delete(artifactId)
  })
  return next
}

/** Who hears that an artifact's values were reset: its open frames, which load again. */
const resetListeners = new Set<(artifactId: string) => void>()

export function onPageStateReset(listener: (artifactId: string) => void): () => void {
  resetListeners.add(listener)
  return () => resetListeners.delete(listener)
}

/**
 * Deletes every value the reader's page keeps, for *Reset page data*, after the calls already
 * made; every open frame of it then starts over.
 */
export async function resetPageState(queries: QueryClient, artifactId: string): Promise<void> {
  await (queues.get(artifactId) ?? Promise.resolve())
  await clearArtifactState({ path: { artifactId }, throwOnError: true })
  queries.setQueryData<KeptValues>(stateKey(artifactId), new Map())
  for (const listener of resetListeners) listener(artifactId)
}

/** How many values the reader's page keeps, as far as the app has read: none until it asks. */
export function usePageStateCount(artifactId: string): number {
  const { data } = useQuery<KeptValues>({
    queryKey: stateKey(artifactId),
    // Read by the frame's first call; this only follows what it read.
    enabled: false,
  })
  return data?.size ?? 0
}

async function runCall(
  queries: QueryClient,
  artifactId: string,
  call: FrameCall
): Promise<unknown> {
  const update = (change: (values: Map<string, unknown>) => void) =>
    queries.setQueryData<KeptValues>(stateKey(artifactId), (current) => {
      const values = new Map(current)
      change(values)
      return values
    })
  try {
    const kept = await keptValues(queries, artifactId)
    switch (call.method) {
      case "state.get":
        return kept.get(call.params.key)
      case "state.keys":
        // In code-unit order, as the API lists them.
        return [...kept.keys()].sort((left, right) => (left < right ? -1 : 1))
      case "state.set": {
        const { data } = await setArtifactState({
          path: { artifactId, key: call.params.key },
          body: { value: call.params.value },
          throwOnError: true,
        })
        update((values) => values.set(call.params.key, data.value))
        return undefined
      }
      case "state.delete": {
        const { data } = await deleteArtifactStateValue({
          path: { artifactId, key: call.params.key },
          throwOnError: true,
        })
        update((values) => values.delete(call.params.key))
        return data.deleted
      }
    }
  } catch (error) {
    throw new Error(reason(error))
  }
}

async function keptValues(queries: QueryClient, artifactId: string): Promise<KeptValues> {
  return queries.fetchQuery({
    queryKey: stateKey(artifactId),
    queryFn: async () => {
      const { data } = await getArtifactState({ path: { artifactId }, throwOnError: true })
      return new Map(data.entries.map((entry) => [entry.key, entry.value])) as KeptValues
    },
    staleTime: STATE_STALE_MS,
  })
}

/** What the page's promise rejects with: the API's own words when it gave any. */
function reason(error: unknown): string {
  if (isSixbApiError(error)) {
    const body = error.body as { error?: unknown } | null
    if (typeof body?.error === "string") return body.error
  }
  return "[SixbApp] The page's data could not be saved. Try again."
}
