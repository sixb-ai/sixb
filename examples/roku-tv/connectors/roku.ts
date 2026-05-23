import { rest } from "@sixb/connector-rest"
import type { ConnectorContext } from "@sixb/core"
import { defineConnector } from "@sixb/core"
import { type RokuApi, RokuApiService } from "../lib/roku/api"
import { normalizeRokuHost } from "../lib/roku/discovery"
import { DEFAULT_ROKU_TIMEOUT_MS } from "../lib/roku/types"

export interface RokuConnectorClient {
  forHost(host: string): Promise<RokuApi>
}

class RokuConnectorService implements RokuConnectorClient {
  private readonly clients = new Map<string, Promise<RokuApiService>>()

  constructor(private readonly context: ConnectorContext) {}

  forHost(host: string): Promise<RokuApiService> {
    const normalizedHost = normalizeRokuHost(host)
    const existing = this.clients.get(normalizedHost)
    if (existing) {
      return existing
    }

    const created = this.createClient(normalizedHost)
    this.clients.set(normalizedHost, created)
    void created.catch(() => {
      if (this.clients.get(normalizedHost) === created) {
        this.clients.delete(normalizedHost)
      }
    })

    return created
  }

  private async createClient(host: string): Promise<RokuApiService> {
    const client = await rest({
      baseUrl: `http://${host}`,
      timeoutMs: DEFAULT_ROKU_TIMEOUT_MS,
    }).connect(this.context)

    return new RokuApiService(client, host)
  }
}

export const rokuConnector = defineConnector("roku", {
  type: "roku",
  connect(context) {
    return new RokuConnectorService(context)
  },
})
