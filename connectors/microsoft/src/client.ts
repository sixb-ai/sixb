import type { MicrosoftHttp } from "./http"
import { type DrivesSurface, drivesSurface } from "./surfaces/drives"
import { type SitesResource, sitesResource } from "./surfaces/sites"

export interface MicrosoftClient {
  readonly sites: SitesResource
  readonly drives: DrivesSurface
}

export function createMicrosoftClient(http: MicrosoftHttp): MicrosoftClient {
  return { sites: sitesResource(http), drives: drivesSurface(http) }
}
