import type { AccountsResource } from "../resources/accounts"
import type { ChatsResource } from "../resources/chats"
import type { HostedAuthResource } from "../resources/hosted-auth"
import type { LinkedinResource } from "../resources/linkedin"
import type { MessagesResource } from "../resources/messages"
import type { UsersResource } from "../resources/users"
import type { WebhooksResource } from "../resources/webhooks"

export interface UnipileClient {
  readonly accounts: AccountsResource
  readonly hostedAuth: HostedAuthResource
  readonly linkedin: LinkedinResource
  readonly users: UsersResource
  readonly chats: ChatsResource
  readonly messages: MessagesResource
  readonly webhooks: WebhooksResource
}
