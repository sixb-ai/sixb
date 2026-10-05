import { createPlaudClient } from "./client"
import { createHttp } from "./http"
import { createPlaudOAuth } from "./oauth"
import type { PlaudConnector, PlaudConnectorOptions } from "./types"
import { integer, nonEmpty } from "./validation"

/** Plaud data access with the authorization lifecycle owned by Sixb. */
export function plaud(input: PlaudConnectorOptions): PlaudConnector {
  const options = {
    ...input,
    downloadHosts: input.downloadHosts ? [...input.downloadHosts] : undefined,
  }
  nonEmpty(options.clientId, "clientId")
  integer(options.timeoutMs ?? 30_000, 1, "timeoutMs")
  integer(options.maxRetries ?? 2, 0, "maxRetries")
  integer(options.minDelayMs ?? 0, 0, "minDelayMs")
  integer(options.maxContentBytes ?? 20 * 1024 * 1024, 1, "maxContentBytes")
  for (const host of options.downloadHosts ?? []) {
    if (
      !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(host) ||
      !host.includes(".") ||
      /^[\d.]+$/.test(host)
    )
      throw new Error(
        "[SixbPlaud] downloadHosts must contain exact DNS hostnames, without URLs or wildcards."
      )
  }
  return {
    type: "plaud",
    authentication: createPlaudOAuth(options),
    async discoverAccounts(context, credentials) {
      const client = createPlaudClient(
        await createHttp(
          context,
          {
            async get() {
              return { accessToken: credentials.accessToken, invalidate() {} }
            },
          },
          options,
          false
        )
      )
      const user = await client.users.current()
      return [
        { id: user.id, label: user.nickname || user.email || user.id, description: user.email },
      ]
    },
    async connect(context) {
      context.signal.throwIfAborted()
      return createPlaudClient(await createHttp(context, context.tokenSource, options))
    },
  }
}
