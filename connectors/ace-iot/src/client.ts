import type { AceIotHttp } from "./http"
import { createClientsResource } from "./resources/clients"
import { createGatewaysResource } from "./resources/gateways"
import { createPointsResource } from "./resources/points"
import { createSitesResource } from "./resources/sites"
import type { AceIotClient } from "./types"

export function createAceIotClient(http: AceIotHttp): AceIotClient {
  return {
    clients: createClientsResource(http),
    sites: createSitesResource(http),
    points: createPointsResource(http),
    gateways: createGatewaysResource(http),
  }
}
