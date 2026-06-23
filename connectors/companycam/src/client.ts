import type { Http } from "./http"
import type { PhotosResource } from "./resources/photos"
import { photosResource } from "./resources/photos"
import type { ProjectsResource } from "./resources/projects"
import { projectsResource } from "./resources/projects"
import type { WebhooksResource } from "./resources/webhooks"
import { webhooksResource } from "./resources/webhooks"
import type { CompanyCamEventHandler } from "./types"

export interface CompanyCamConnectorOptions {
  /** CompanyCam Direct Access Token (app.companycam.com/access_tokens). */
  readonly token: string
  /** API base URL. Defaults to https://api.companycam.com/v2/. */
  readonly baseUrl?: string
  /** Shared secret used both as the webhook `token` and the inbound HMAC verify key. */
  readonly webhookSecret?: string
  /** Invoked for each verified inbound webhook delivery. */
  readonly onEvent?: CompanyCamEventHandler
}

/** Typed CompanyCam client, grouped by resource. */
export interface CompanyCamClient {
  readonly projects: ProjectsResource
  readonly photos: PhotosResource
  readonly webhooks: WebhooksResource
}

export function createCompanyCamClient(http: Http, defaultWebhookToken?: string): CompanyCamClient {
  return {
    projects: projectsResource(http),
    photos: photosResource(http),
    webhooks: webhooksResource(http, defaultWebhookToken),
  }
}
