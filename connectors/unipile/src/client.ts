import type { UnipileHttp } from "./http"
import { createAccountsResource } from "./resources/accounts"
import { createChatsResource } from "./resources/chats"
import { createHostedAuthResource } from "./resources/hosted-auth"
import { createLinkedinResource } from "./resources/linkedin"
import { createMessagesResource } from "./resources/messages"
import { createUsersResource } from "./resources/users"
import { createWebhooksResource } from "./resources/webhooks"
import type { UnipileClient } from "./types"

export interface CreateUnipileClientOptions {
  readonly dsn: string
  readonly webhookSecret?: string
}

export function createUnipileClient(
  http: UnipileHttp,
  options: CreateUnipileClientOptions
): UnipileClient {
  return {
    accounts: createAccountsResource(http),
    hostedAuth: createHostedAuthResource(http, options.dsn),
    linkedin: createLinkedinResource(http),
    users: createUsersResource(http),
    chats: createChatsResource(http),
    messages: createMessagesResource(http),
    webhooks: createWebhooksResource(http, options.webhookSecret),
  }
}
