export interface ListWindow {
  readonly limit?: number
  readonly offset?: number
}

export interface ListPage<T> {
  readonly page: readonly T[]
  readonly total: number
  readonly hasMore: boolean
}

export function paginate<T>(values: readonly T[], input: ListWindow): ListPage<T> {
  const offset = input.offset ?? 0
  const limit = input.limit ?? values.length
  const total = values.length
  const page = values.slice(offset, offset + limit)

  return {
    page,
    total,
    hasMore: offset + page.length < total,
  }
}
