import { createPlaudClient } from "./client"
import { createHttp } from "./http"
import { createTokenSource } from "./oauth"
import type { PlaudConnector, PlaudConnectorOptions } from "./types"
import { integer } from "./validation"

/** Personal Plaud account access using the HTTP endpoints behind Plaud's official MCP/CLI. */
export function plaud(input: PlaudConnectorOptions = {}): PlaudConnector {
  const options = {
    ...input,
    downloadHosts: input.downloadHosts ? [...input.downloadHosts] : undefined,
  }
  integer(options.timeoutMs ?? 30_000, 1, "timeoutMs")
  integer(options.maxRetries ?? 2, 0, "maxRetries")
  integer(options.minDelayMs ?? 0, 0, "minDelayMs")
  integer(options.maxContentBytes ?? 20 * 1024 * 1024, 1, "maxContentBytes")
  if (options.tokenFile && options.tokenStore)
    throw new Error("[SixbPlaud] Supply tokenFile or tokenStore, not both.")
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
    async connect(context) {
      context.signal.throwIfAborted()
      return createPlaudClient(
        await createHttp(context, createTokenSource(options, context.signal), options)
      )
    },
  }
}
