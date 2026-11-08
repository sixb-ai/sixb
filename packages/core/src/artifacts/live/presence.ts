import type { Broker, BrokerRetention, BrokerStreamDefinition } from "../../broker"
import type { JsonObject } from "../../json"
import type { ArtifactVersionRecord } from "../../storage/artifacts/types"

// What servers holding an artifact live tell each other, on one broker stream per artifact: the
// document's updates, so editors on two servers edit as one, and the Agent's presence, so a board
// it is changing says so wherever it is open. Awareness, who is there and what they point at, has
// a stream of its own. Short-lived by nature:
// what is written back is in storage, so retention only has to outlast a write-back.

/** Minutes of records a server opening an artifact can still read; presence is renewed sooner. */
const ARTIFACT_LIVE_RETENTION: BrokerRetention = { maxAgeMs: 10 * 60_000, maxRecords: 5_000 }

/** How long the Agent's presence lasts unless its turn ends sooner, as a crashed turn's would. */
export const AGENT_PRESENCE_MS = 10 * 60_000

export function artifactLiveStream(artifactId: string): BrokerStreamDefinition {
  return { id: `artifacts.live.${artifactId}`, retention: ARTIFACT_LIVE_RETENTION }
}

/**
 * Where servers holding an artifact share who is there and what they point at: apart from the
 * document's updates, so that cursors moving never push an update out of the replay window. Only
 * what is recent matters, so it keeps a minute.
 */
const ARTIFACT_PRESENCE_RETENTION: BrokerRetention = { maxAgeMs: 60_000, maxRecords: 1_000 }

export function artifactPresenceStream(artifactId: string): BrokerStreamDefinition {
  return { id: `artifacts.presence.${artifactId}`, retention: ARTIFACT_PRESENCE_RETENTION }
}

/** One record of an artifact's live stream. */
export type ArtifactLiveRecord =
  /** An update an editor made to the document on a server, as Yjs encodes it, in base64. */
  | {
      readonly name: "update"
      readonly payload: { readonly instance: string; readonly update: string }
    }
  /** A server's awareness update, as y-protocols encodes it, in base64. */
  | {
      readonly name: "awareness"
      readonly payload: { readonly instance: string; readonly update: string }
    }
  /** An Agent turn wrote these boards, and is still at work. */
  | {
      readonly name: "agent"
      readonly payload: {
        readonly runId: string
        readonly boards: readonly string[]
        readonly at: string
      }
    }
  /** The turn ended: it changes nothing more. */
  | { readonly name: "agent-ended"; readonly payload: { readonly runId: string } }

/** Reads a record of an artifact's live stream; null for anything else. */
export function parseArtifactLiveRecord(record: {
  readonly name?: string
  readonly payload: unknown
}): ArtifactLiveRecord | null {
  const payload = record.payload
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return null
  const value = payload as Record<string, unknown>

  switch (record.name) {
    case "update":
    case "awareness":
      return typeof value.instance === "string" && typeof value.update === "string"
        ? { name: record.name, payload: { instance: value.instance, update: value.update } }
        : null
    case "agent":
      return typeof value.runId === "string" &&
        typeof value.at === "string" &&
        Array.isArray(value.boards) &&
        value.boards.every((board) => typeof board === "string")
        ? {
            name: "agent",
            payload: { runId: value.runId, boards: value.boards as string[], at: value.at },
          }
        : null
    case "agent-ended":
      return typeof value.runId === "string"
        ? { name: "agent-ended", payload: { runId: value.runId } }
        : null
    default:
      return null
  }
}

/** Appends to an artifact's live stream. */
export async function appendArtifactLive(
  broker: Pick<Broker, "ensureStream" | "append">,
  projectId: string,
  artifactId: string,
  record: ArtifactLiveRecord
): Promise<void> {
  const stream = artifactLiveStream(artifactId)
  await broker.ensureStream({ projectId, stream })
  await broker.append({
    projectId,
    streamId: stream.id,
    records: [{ name: record.name, payload: { ...record.payload } as JsonObject }],
  })
}

/**
 * The boards of a canvas a write changed: added, or showing something else, as their render keys
 * say. A board only moved shows what it showed.
 */
export function changedBoards(
  before: Pick<ArtifactVersionRecord, "outline"> | null,
  after: Pick<ArtifactVersionRecord, "outline">
): string[] {
  if (after.outline.kind !== "canvas") return []

  const kept = new Map<string, string | undefined>()
  if (before?.outline.kind === "canvas") {
    for (const item of before.outline.items) {
      if (item.type === "board") kept.set(item.id, item.renderKey)
    }
  }
  return after.outline.items.flatMap((item) =>
    item.type === "board" && (!kept.has(item.id) || kept.get(item.id) !== item.renderKey)
      ? [item.id]
      : []
  )
}
