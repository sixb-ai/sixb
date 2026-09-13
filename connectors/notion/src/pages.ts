import { type RestClient, readResponseBody, withQuery } from "@sixb/connector-rest"
import { isRecord, NotionApiError } from "./errors"
import type { NotionPagesResource, NotionRequestOptions } from "./types"

export function createPagesResource(http: RestClient): NotionPagesResource {
  async function request<T>(
    method: "GET" | "POST" | "PATCH",
    path: string,
    expected: "page" | "property" | "page_markdown",
    body?: unknown,
    options?: NotionRequestOptions
  ): Promise<T> {
    const response = await http.request(path, {
      method,
      body,
      signal: options?.signal,
      redirect: "error",
    })
    const result = await readResponseBody(response)
    if (!response.ok) throw new NotionApiError(response.status, result, response.headers)
    if (!isExpectedResponse(result, expected)) {
      throw new Error(
        `[SixbNotion] Invalid ${expected} response from Notion (HTTP ${response.status}).`
      )
    }
    // Wire types come from the official SDK. Validate the envelope here while preserving
    // provider fields, scalar/list property unions, and Markdown completeness metadata.
    return result as T
  }

  const pages: NotionPagesResource = {
    retrieve({ page_id, filter_properties }, options) {
      return request(
        "GET",
        withQuery(pagePath(page_id), { filter_properties }),
        "page",
        undefined,
        options
      )
    },
    create(parameters, options) {
      assertSynchronous(parameters)
      const { filter_properties, ...body } = parameters
      const contentFields = [body.markdown, body.children, body.content].filter(
        (value) => value !== undefined
      )
      if (contentFields.length > 1) {
        throw new Error("[SixbNotion] Provide only one of markdown, children, or content.")
      }
      return request("POST", withQuery("pages", { filter_properties }), "page", body, options)
    },
    update(parameters, options) {
      if ("archived" in parameters) {
        throw new Error("[SixbNotion] Use in_trash instead of archived with API 2026-03-11.")
      }
      const { page_id, filter_properties, ...body } = parameters
      return request(
        "PATCH",
        withQuery(pagePath(page_id), { filter_properties }),
        "page",
        body,
        options
      )
    },
    move({ page_id, parent }, options) {
      return request("POST", `${pagePath(page_id)}/move`, "page", { parent }, options)
    },
    trash({ page_id }, options) {
      return pages.update({ page_id, in_trash: true }, options)
    },
    restore({ page_id }, options) {
      return pages.update({ page_id, in_trash: false }, options)
    },
    retrieveMarkdown({ page_id, include_transcript }, options) {
      return request(
        "GET",
        withQuery(`${pagePath(page_id)}/markdown`, { include_transcript }),
        "page_markdown",
        undefined,
        options
      )
    },
    updateMarkdown(parameters, options) {
      assertSynchronous(parameters)
      const { page_id, ...body } = parameters
      return request("PATCH", `${pagePath(page_id)}/markdown`, "page_markdown", body, options)
    },
    properties: {
      retrieve({ page_id, property_id, start_cursor, page_size }, options) {
        if (
          page_size !== undefined &&
          (!Number.isInteger(page_size) || page_size < 1 || page_size > 100)
        ) {
          throw new Error("[SixbNotion] page_size must be an integer between 1 and 100.")
        }
        return request(
          "GET",
          withQuery(`${pagePath(page_id)}/properties/${propertySegment(property_id)}`, {
            start_cursor,
            page_size,
          }),
          "property",
          undefined,
          options
        )
      },
    },
  }
  return pages
}

function pagePath(id: string): string {
  if (
    typeof id !== "string" ||
    !/^(?:[\da-f]{32}|[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12})$/i.test(id)
  ) {
    throw new Error("[SixbNotion] page_id must be a Notion UUID, not a page URL.")
  }
  return `pages/${id}`
}

function propertySegment(id: string): string {
  if (typeof id !== "string" || !id.trim()) {
    throw new Error("[SixbNotion] property_id must be a non-empty string.")
  }
  // Notion returns short property IDs already URL-encoded. Accept those or raw IDs,
  // encoding exactly once; never treat next_url or a property ID as a request URL.
  let decoded = id
  try {
    decoded = decodeURIComponent(id)
  } catch {
    // A raw percent sign is valid input and will be escaped below.
  }
  if (decoded === "." || decoded === "..") {
    throw new Error("[SixbNotion] property_id must not be a dot path segment.")
  }
  return encodeURIComponent(decoded)
}

function assertSynchronous(parameters: { allow_async?: boolean }): void {
  if (parameters.allow_async !== undefined && parameters.allow_async !== false) {
    throw new Error("[SixbNotion] allow_async is not supported; omit it or set it to false.")
  }
}

function isExpectedResponse(value: unknown, expected: string): boolean {
  if (!isRecord(value)) return false
  if (expected === "property") {
    if (value.object === "property_item")
      return typeof value.id === "string" && typeof value.type === "string"
    return (
      value.object === "list" &&
      Array.isArray(value.results) &&
      typeof value.has_more === "boolean" &&
      (value.next_cursor === null || typeof value.next_cursor === "string")
    )
  }
  if (value.object !== expected || typeof value.id !== "string") return false
  return (
    expected !== "page_markdown" ||
    (typeof value.markdown === "string" &&
      typeof value.truncated === "boolean" &&
      Array.isArray(value.unknown_block_ids) &&
      value.unknown_block_ids.every((id) => typeof id === "string"))
  )
}
