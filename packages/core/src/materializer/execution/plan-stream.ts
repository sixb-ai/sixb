import { utf8JsonByteLength } from "../../materialization/refs"
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
} from "../../storage/ontology"
import type { MaterializationBatching } from "../shared/batching"
import { chunkBySize } from "../shared/chunking"

export type MaterializationPlanItem =
  | MaterializationPlanWorkItem
  | { readonly kind: "outbox"; readonly value: OntologyOutboxWrite }

export async function* planStream(
  items: Iterable<MaterializationPlanItem> | AsyncIterable<MaterializationPlanItem>,
  batching: MaterializationBatching
): AsyncIterable<MaterializationPlanChunk> {
  for await (const itemsChunk of chunkBySize(items, {
    maxRows: batching.planChunkRows,
    maxBytes: batching.planChunkBytes,
    byteLength: utf8JsonByteLength,
  })) {
    const chunk = mutableChunk()
    for (const item of itemsChunk) appendItem(chunk, item)
    yield chunk
  }
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
