import type { INetworkModule, NetworkRequestOptions, NetworkResponse } from "@azure/msal-node"
import { type RestClient, readResponseBody } from "@sixb/connector-rest"
import { MicrosoftProtocolError } from "../errors"
import { httpsUrl } from "../validation"

/** MSAL 6's default POST transport has no timeout. Use its supported network extension. */
export function authNetwork(http: RestClient): INetworkModule {
  const send = async <T>(
    url: string,
    method: "GET" | "POST",
    options?: NetworkRequestOptions
  ): Promise<NetworkResponse<T>> => {
    if (httpsUrl(url).hostname !== "login.microsoftonline.com") {
      throw new MicrosoftProtocolError(
        "Authentication requests must stay on login.microsoftonline.com."
      )
    }
    const response = await http.request(
      url,
      {
        method,
        headers: options?.headers,
        body: options?.body,
        redirect: "error",
      },
      { idempotent: true }
    )
    return {
      status: response.status,
      headers: Object.fromEntries(response.headers),
      body: (await readResponseBody(response)) as T,
    }
  }
  return {
    sendGetRequestAsync: (url, options) => send(url, "GET", options),
    sendPostRequestAsync: (url, options) => send(url, "POST", options),
  }
}
