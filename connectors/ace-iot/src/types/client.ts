import type { ClientsResource } from "../resources/clients"
import type { GatewaysResource } from "../resources/gateways"
import type { PointsResource } from "../resources/points"
import type { SitesResource } from "../resources/sites"

/** The connected ACE IoT client. One property per tag in ACE's own API surface. */
export interface AceIotClient {
  readonly clients: ClientsResource
  readonly sites: SitesResource
  readonly points: PointsResource
  readonly gateways: GatewaysResource
}
