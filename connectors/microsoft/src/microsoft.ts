import { rest } from "@sixb/connector-rest"
import type { ConnectorAdapter } from "@sixb/core"
import { createTokenSource, validateAuth } from "./auth"
import { createMicrosoftClient, type MicrosoftClient } from "./client"
import { MicrosoftConfigurationError } from "./errors"
import { createMicrosoftHttp } from "./http"
import { withSignal } from "./lifetime"
import type { MicrosoftConnectorOptions } from "./types/common"
import { GRAPH_BASE } from "./validation"

export type MicrosoftConnector = ConnectorAdapter<"microsoft", MicrosoftClient>

export function microsoft(options: MicrosoftConnectorOptions): MicrosoftConnector {
  validateAuth(options.auth)
  const timeoutMs = options.timeoutMs ?? 30_000
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0)
    throw new MicrosoftConfigurationError("timeoutMs must be a positive integer.")
  return {
    type: "microsoft",
    async connect(context) {
      const common = {
        timeoutMs,
        minDelayMs: options.minDelayMs,
        retry: options.retry ?? { maxRetries: 2 },
      }
      const authHttp = await rest({
        ...common,
        baseUrl: "https://login.microsoftonline.com/",
      }).connect(context)
      const token = createTokenSource(options.auth, authHttp, context.signal, timeoutMs)
      const graph = await rest({
        ...common,
        baseUrl: GRAPH_BASE,
        headers: async (request) => ({
          Authorization: `Bearer ${await withSignal(token.get(), request.init.signal ?? context.signal)}`,
        }),
        onUnauthorized: () => token.invalidate(),
      }).connect(context)
      const media = await rest({ ...common, baseUrl: GRAPH_BASE }).connect(context)
      return createMicrosoftClient(createMicrosoftHttp(graph, media, context.signal))
    },
  }
}
