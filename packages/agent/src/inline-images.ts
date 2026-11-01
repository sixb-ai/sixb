import { AGENT_INLINE_IMAGE_LIMITS } from "@sixb/core/internal/agents"

/** What a request says in place of an attachment's image the budget left out. */
export const INLINE_IMAGE_BUDGET_NOTE =
  "[Image not inlined: the conversation's inline image budget is used up until it is compacted; the file is available through the sandbox path or content URL.]"

/** How many images a request projects at once while the budget decides them in order. */
const PROJECTION_CONCURRENCY = 4

/**
 * What one request has left of {@link AGENT_INLINE_IMAGE_LIMITS}. A run takes from it in thread
 * order, oldest first: the history's attachments and tool images, then the images its own steps
 * return. The first image that does not fit closes it, so nothing after it is projected at all. A
 * replay walks the same order: an image that fitted keeps its inline data until compaction, and one
 * that did not stays metadata from its own turn on.
 */
export class InlineImageBudget {
  #bytes = 0
  #images = 0
  #closed = false

  /** Whether no further image can go inline in this request. */
  get closed(): boolean {
    return this.#closed
  }

  /** Count the image in when it fits what is left; one that does not closes the budget. */
  take(data: URL): boolean {
    const bytes = data.href.length
    this.#closed ||=
      this.#images >= AGENT_INLINE_IMAGE_LIMITS.maxImages ||
      this.#bytes + bytes > AGENT_INLINE_IMAGE_LIMITS.maxBytes
    if (this.#closed) return false

    this.#bytes += bytes
    this.#images += 1
    return true
  }
}

/**
 * Project images and let the budget decide each, in their order: a few run ahead at once, while
 * every decision waits for the ones before it. Once the budget closes, the rest are never projected:
 * `decide` gets `undefined` for them.
 */
export async function projectInOrder<TItem, TProjection>(input: {
  readonly items: readonly TItem[]
  readonly budget: InlineImageBudget
  readonly project: (item: TItem) => Promise<TProjection>
  readonly decide: (item: TItem, projection: TProjection | undefined) => void
}): Promise<void> {
  const { items, budget } = input
  const projections: Promise<TProjection>[] = []

  for (const [index, item] of items.entries()) {
    if (budget.closed) {
      input.decide(item, undefined)
      continue
    }

    while (projections.length < Math.min(items.length, index + PROJECTION_CONCURRENCY)) {
      const projection = input.project(items[projections.length] as TItem)
      // Awaited in order below; one the budget no longer needs must not go unhandled.
      projection.catch(() => {})
      projections.push(projection)
    }
    input.decide(item, await projections[index])
  }
}
