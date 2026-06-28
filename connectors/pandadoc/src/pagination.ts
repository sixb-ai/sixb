import type { PandaDocPageOptions } from "./types"

type PandaDocListMethod<TOptions extends PandaDocPageOptions, TPage> = (
  options?: TOptions
) => Promise<TPage>

export async function* listAllPages<TOptions extends PandaDocPageOptions, TPage, TItem>(
  list: PandaDocListMethod<TOptions, TPage>,
  items: (page: TPage) => readonly TItem[],
  options?: TOptions
): AsyncIterable<TItem> {
  const pageSize = options?.count ?? 50
  let page = options?.page ?? 1

  for (;;) {
    const response = await list({ ...options, page } as TOptions)
    const batch = items(response)
    for (const item of batch) {
      yield item
    }

    if (batch.length === 0 || batch.length < pageSize) {
      break
    }

    page += 1
  }
}
