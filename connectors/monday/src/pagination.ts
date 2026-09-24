/** Fetch the terminal empty page when an offset API supplies no has_more flag. */
export async function* pages<T>(
  fetch: (page: number) => Promise<T[]>,
  page: number,
  limit: number
): AsyncIterable<T> {
  for (;;) {
    const entries = await fetch(page++)
    yield* entries
    if (entries.length < limit) return
  }
}
