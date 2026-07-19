export async function* chunkBySize<T>(
  items: Iterable<T> | AsyncIterable<T>,
  input: {
    readonly maxRows: number
    readonly maxBytes: number
    readonly byteLength: (item: T) => number
  }
): AsyncIterable<readonly T[]> {
  let chunk: T[] = []
  let bytes = 0
  for await (const item of items) {
    const itemBytes = input.byteLength(item)
    if (chunk.length > 0 && (chunk.length >= input.maxRows || bytes + itemBytes > input.maxBytes)) {
      yield chunk
      chunk = []
      bytes = 0
    }
    chunk.push(item)
    bytes += itemBytes
  }
  if (chunk.length > 0) yield chunk
}
