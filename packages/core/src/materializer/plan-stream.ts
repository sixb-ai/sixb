import type {
  ExactEffectiveLinkDelete,
  ExactEffectiveLinkWrite,
  ExactEffectiveObjectDelete,
  ExactEffectiveObjectWrite,
  ExactLinkOverrideDelete,
  ExactLinkOverrideWrite,
  ExactObjectOverrideDelete,
  ExactObjectOverrideWrite,
  ExactTimeseriesPointWrite,
  MaterializationPlanChunk,
  MaterializationPlanWorkItem,
  OntologyOutboxWrite,
} from "../storage/ontology"
import type { MaterializationBatching } from "./batching"
import { utf8JsonByteLength } from "./refs"

export type MaterializationPlanItem =
  | MaterializationPlanWorkItem
  | { readonly kind: "outbox"; readonly value: OntologyOutboxWrite }

export async function* planStream(
  items: Iterable<MaterializationPlanItem> | AsyncIterable<MaterializationPlanItem>,
  batching: MaterializationBatching
): AsyncIterable<MaterializationPlanChunk> {
  let chunk = mutableChunk()
  let rows = 0
  let bytes = 0
  for await (const item of items) {
    const itemBytes = utf8JsonByteLength(item)
    if (
      rows > 0 &&
      (rows >= batching.planChunkRows || bytes + itemBytes > batching.planChunkBytes)
    ) {
      yield freezeChunk(chunk)
      chunk = mutableChunk()
      rows = 0
      bytes = 0
    }
    appendItem(chunk, item)
    rows += 1
    bytes += itemBytes
  }
  if (rows > 0) yield freezeChunk(chunk)
}

type MutableChunk = {
  overrides: {
    objectUpserts: ExactObjectOverrideWrite[]
    objectDeletes: ExactObjectOverrideDelete[]
    linkUpserts: ExactLinkOverrideWrite[]
    linkDeletes: ExactLinkOverrideDelete[]
  }
  effective: {
    objectUpserts: ExactEffectiveObjectWrite[]
    objectDeletes: ExactEffectiveObjectDelete[]
    linkUpserts: ExactEffectiveLinkWrite[]
    linkDeletes: ExactEffectiveLinkDelete[]
  }
  timeseries: { pointUpserts: ExactTimeseriesPointWrite[] }
  outbox: OntologyOutboxWrite[]
}

function mutableChunk(): MutableChunk {
  return {
    overrides: { objectUpserts: [], objectDeletes: [], linkUpserts: [], linkDeletes: [] },
    effective: { objectUpserts: [], objectDeletes: [], linkUpserts: [], linkDeletes: [] },
    timeseries: { pointUpserts: [] },
    outbox: [],
  }
}

function appendItem(chunk: MutableChunk, item: MaterializationPlanItem): void {
  switch (item.kind) {
    case "object-override-upsert":
      chunk.overrides.objectUpserts.push(item.value)
      break
    case "object-override-delete":
      chunk.overrides.objectDeletes.push(item.value)
      break
    case "link-override-upsert":
      chunk.overrides.linkUpserts.push(item.value)
      break
    case "link-override-delete":
      chunk.overrides.linkDeletes.push(item.value)
      break
    case "object-upsert":
      chunk.effective.objectUpserts.push(item.value)
      break
    case "object-delete":
      chunk.effective.objectDeletes.push(item.value)
      break
    case "link-upsert":
      chunk.effective.linkUpserts.push(item.value)
      break
    case "link-delete":
      chunk.effective.linkDeletes.push(item.value)
      break
    case "point-upsert":
      chunk.timeseries.pointUpserts.push(item.value)
      break
    case "outbox":
      chunk.outbox.push(item.value)
      break
  }
}

function freezeChunk(chunk: MutableChunk): MaterializationPlanChunk {
  return chunk
}
