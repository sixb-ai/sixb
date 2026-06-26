import type {
  PipedriveCursorOptions,
  PipedriveCursorPage,
  PipedriveOffsetOptions,
  PipedriveOffsetPage,
} from "./types"

type CursorListMethod<TOptions extends PipedriveCursorOptions, TItem> = (
  options?: TOptions
) => Promise<PipedriveCursorPage<TItem>>

type OffsetListMethod<TOptions extends PipedriveOffsetOptions, TItem> = (
  options?: TOptions
) => Promise<PipedriveOffsetPage<TItem>>

export async function* listAllCursor<TOptions extends PipedriveCursorOptions, TItem>(
  list: CursorListMethod<TOptions, TItem>,
  options?: TOptions
): AsyncIterable<TItem> {
  let cursor = options?.cursor

  for (;;) {
    const response = await list({ ...options, cursor } as TOptions)
    for (const item of response.data) {
      yield item
    }

    cursor = response.additional_data?.next_cursor ?? undefined
    if (!cursor) {
      break
    }
  }
}

export async function* listAllOffset<TOptions extends PipedriveOffsetOptions, TItem>(
  list: OffsetListMethod<TOptions, TItem>,
  options?: TOptions
): AsyncIterable<TItem> {
  let start = options?.start ?? 0

  for (;;) {
    const response = await list({ ...options, start } as TOptions)
    for (const item of response.data) {
      yield item
    }

    const pagination = response.additional_data?.pagination
    if (!pagination?.more_items_in_collection || pagination.next_start === undefined) {
      break
    }

    start = pagination.next_start
  }
}
