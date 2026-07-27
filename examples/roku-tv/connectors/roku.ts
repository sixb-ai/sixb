import { rest } from "@sixb/connector-rest"
import type { ConnectorContext } from "@sixb/core"
import { defineConnector } from "@sixb/core"
import { type RokuApi, RokuApiService } from "../lib/roku/api"
import { discoverRokuDevices, normalizeRokuHost } from "../lib/roku/discovery"
import type { DiscoveredRokuDevice, RokuDiscoveryOptions } from "../lib/roku/types"
import { DEFAULT_ROKU_TIMEOUT_MS } from "../lib/roku/types"

export interface RokuConnectorClient {
  discover(options?: RokuDiscoveryOptions): Promise<DiscoveredRokuDevice[]>
  forHost(host: string): Promise<RokuApi>
}

class RokuConnectorService implements RokuConnectorClient {
  private readonly clients = new Map<string, Promise<RokuApiService>>()

  constructor(private readonly context: ConnectorContext) {}

  discover(options?: RokuDiscoveryOptions): Promise<DiscoveredRokuDevice[]> {
    return discoverRokuDevices(options)
  }

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
  connect(context): RokuConnectorClient {
    return new RokuConnectorService(context)
  },
})
