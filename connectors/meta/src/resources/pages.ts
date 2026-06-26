import { DEFAULT_PAGE_FIELDS } from "../fields"
import { type MetaHttpContext, paginate, readPage, withQuery } from "../http"
import type { MetaPage } from "../types/common"
import type { MetaFacebookPage, PagesApi, PagesListOptions } from "../types/pages"

export function createPagesApi(context: MetaHttpContext): PagesApi {
  return {
    list: (options) => listPage(context, options, options?.after),
    listAll: (options) => paginate((after) => listPage(context, options, after)),
  }
}

function listPage(
  context: MetaHttpContext,
  options: PagesListOptions | undefined,
  after: string | undefined
): Promise<MetaPage<MetaFacebookPage>> {
  const path = withQuery("me/accounts", {
    fields: (options?.fields ?? DEFAULT_PAGE_FIELDS).join(","),
    limit: options?.limit ?? 100,
    after,
  })
  return context.http.get(path).then((response) => readPage(response, toFacebookPage))
}

interface RawPage {
  readonly id: string
  readonly name?: string
  readonly access_token?: string
  readonly instagram_business_account?: {
    readonly id: string
    readonly username?: string
    readonly name?: string
    readonly followers_count?: number
    readonly media_count?: number
  }
}

function toFacebookPage(raw: RawPage): MetaFacebookPage {
  return {
    id: raw.id,
    name: raw.name,
    access_token: raw.access_token,
    instagram_business_account: raw.instagram_business_account,
  }
}
