import type { MicrosoftHttp } from "./http"
import { type DrivesSurface, drivesSurface } from "./surfaces/drives"
import { type MailSurface, mailSurface } from "./surfaces/mail"
import { type SitesResource, sitesResource } from "./surfaces/sites"

export interface MicrosoftClient {
  readonly mail: MailSurface
  readonly sites: SitesResource
  readonly drives: DrivesSurface
}

export function createMicrosoftClient(http: MicrosoftHttp): MicrosoftClient {
  return { sites: sitesResource(http), drives: drivesSurface(http), mail: mailSurface(http) }
}
