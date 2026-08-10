import type { UnipileHttp } from "../http"
import type { UnipileHostedAuthLink, UnipileHostedAuthLinkInput } from "../types"
import { assertHttpUrl, assertNonEmpty, assertStringArray, assertTimestamp } from "../validation"

export interface HostedAuthResource {
  /** `POST /hosted/accounts/link` */
  createLink(input: UnipileHostedAuthLinkInput): Promise<UnipileHostedAuthLink>
}

export function createHostedAuthResource(
  http: UnipileHttp,
  defaultApiUrl: string
): HostedAuthResource {
  return {
    createLink(input) {
      assertTimestamp(input.expiresOn, "expiresOn")
      const apiUrl = input.api_url ?? defaultApiUrl
      assertHttpUrl(apiUrl, "api_url")
      assertOptionalUrl(input.success_redirect_url, "success_redirect_url")
      assertOptionalUrl(input.failure_redirect_url, "failure_redirect_url")
      assertOptionalUrl(input.notify_url, "notify_url")

      if (input.type === "create" && Array.isArray(input.providers)) {
        assertStringArray(input.providers, "providers")
      }
      if (input.type === "reconnect") {
        assertNonEmpty(input.reconnect_account, "reconnect_account")
      }

      return http.post("hosted/accounts/link", { ...input, api_url: apiUrl })
    },
  }
}

function assertOptionalUrl(value: string | undefined, label: string): void {
  if (value !== undefined) {
    assertHttpUrl(value, label)
  }
}
