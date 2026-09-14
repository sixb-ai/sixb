import { ConfidentialClientApplication } from "@azure/msal-node"
import type { RestClient } from "@sixb/connector-rest"
import { MicrosoftAuthError, MicrosoftConfigurationError } from "../errors"
import { isRecord } from "../guards"
import { withSignal } from "../lifetime"
import { nonEmpty, segment } from "../validation"
import { authNetwork } from "./network"
import type { MicrosoftAuthOptions } from "./types"

export interface TokenSource {
  get(): Promise<string>
  invalidate(): void
}

export function validateAuth(auth: MicrosoftAuthOptions): void {
  const modes = [
    auth.token !== undefined,
    auth.clientSecret !== undefined,
    auth.clientCertificate !== undefined,
  ]
  if (modes.filter(Boolean).length !== 1)
    throw new MicrosoftConfigurationError(
      "Select exactly one auth mode: token, clientSecret or clientCertificate."
    )
  if (auth.token !== undefined) {
    if (typeof auth.token !== "function")
      throw new MicrosoftConfigurationError("auth.token must be a function.")
    return
  }
  nonEmpty(auth.clientId, "clientId")
  nonEmpty(auth.tenantId, "tenantId")
  if (
    !/^[a-zA-Z0-9.-]+$/.test(auth.tenantId) ||
    ["common", "organizations", "consumers", ".", ".."].includes(auth.tenantId.toLowerCase())
  ) {
    throw new MicrosoftConfigurationError(
      "tenantId must identify a specific tenant (GUID or verified domain)."
    )
  }
  if (auth.clientSecret !== undefined) nonEmpty(auth.clientSecret, "clientSecret")
  if (auth.clientCertificate) {
    if (!/^[a-fA-F0-9]{64}$/.test(auth.clientCertificate.thumbprintSha256)) {
      throw new MicrosoftConfigurationError(
        "clientCertificate.thumbprintSha256 must contain 64 hexadecimal characters."
      )
    }
    nonEmpty(auth.clientCertificate.privateKey, "clientCertificate.privateKey")
  }
}

export function createTokenSource(
  auth: MicrosoftAuthOptions,
  http: RestClient,
  signal: AbortSignal,
  timeoutMs: number
): TokenSource {
  validateAuth(auth)
  // Each connection has its own MSAL cache and lifetime; construction does no network I/O.
  const client = auth.token
    ? undefined
    : new ConfidentialClientApplication({
        auth: {
          clientId: auth.clientId,
          authority: `https://login.microsoftonline.com/${segment(auth.tenantId)}`,
          ...(auth.clientSecret !== undefined
            ? { clientSecret: auth.clientSecret }
            : { clientCertificate: auth.clientCertificate }),
        },
        system: {
          networkClient: authNetwork(http),
          disableInternalRetries: true,
          loggerOptions: { piiLoggingEnabled: false, loggerCallback: () => {} },
        },
      })
  let generation = 0
  let refreshedGeneration = 0
  let pending: { generation: number; promise: Promise<string> } | undefined

  const get = (): Promise<string> => {
    signal.throwIfAborted()
    if (pending?.generation === generation) return pending.promise
    const current = generation
    // Serialize invalidation behind an older acquisition so an old result cannot overwrite MSAL's cache.
    const previous = pending?.promise.catch(() => undefined)
    const promise = (async () => {
      await previous
      const operationSignal = auth.token
        ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
        : signal
      try {
        const forceRefresh = current > refreshedGeneration
        const token = await withSignal(
          auth.token
            ? Promise.resolve().then(() => auth.token({ signal: operationSignal, forceRefresh }))
            : client!
                .acquireTokenByClientCredential({
                  scopes: ["https://graph.microsoft.com/.default"],
                  skipCache: forceRefresh,
                })
                .then((result) => result?.accessToken),
          operationSignal
        )
        if (typeof token !== "string" || !token.trim() || /[\r\n]/.test(token))
          throw new MicrosoftAuthError("invalid_token_response")
        refreshedGeneration = current
        return token
      } catch (error) {
        operationSignal.throwIfAborted()
        if (error instanceof MicrosoftAuthError) throw error
        const code =
          isRecord(error) &&
          typeof error.errorCode === "string" &&
          /^[a-zA-Z0-9_]{1,100}$/.test(error.errorCode)
            ? error.errorCode
            : undefined
        throw new MicrosoftAuthError(code)
      }
    })().finally(() => {
      if (pending?.promise === promise) pending = undefined
    })
    pending = { generation: current, promise }
    return promise
  }
  return {
    get,
    invalidate: () => {
      generation += 1
    },
  }
}
