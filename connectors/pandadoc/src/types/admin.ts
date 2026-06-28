import type { PandaDocJsonObject, PandaDocPageOptions, QueryValue } from "./common"

export interface PandaDocWorkspaceListOptions extends PandaDocPageOptions {}

export interface PandaDocWorkspace extends PandaDocJsonObject {
  readonly id?: string
  readonly uuid?: string
  readonly name?: string
}

export interface PandaDocWorkspaceInput extends PandaDocJsonObject {
  readonly name: string
}

export interface PandaDocUserListOptions extends PandaDocPageOptions {
  readonly show_removed?: boolean
}

export interface PandaDocUser extends PandaDocJsonObject {
  readonly id?: string
  readonly uuid?: string
  readonly email?: string
  readonly first_name?: string
  readonly last_name?: string
}

export interface PandaDocUserInput extends PandaDocJsonObject {
  readonly email: string
}

export interface PandaDocWorkspaceMemberInput extends PandaDocJsonObject {
  readonly user_id?: string
  readonly email?: string
  readonly role?: string
}

export interface PandaDocWorkspaceMemberNotifyOptions {
  readonly [key: string]: QueryValue
  readonly notify_user?: boolean
  readonly notify_ws_admins?: boolean
}

export interface PandaDocWorkspaceMemberRoleInput extends PandaDocJsonObject {
  readonly role: string
}

export interface PandaDocApiKeyInput extends PandaDocJsonObject {
  readonly user_id?: string
  readonly type: "production" | "sandbox" | (string & {})
}

export interface PandaDocUserCreateOptions {
  readonly [key: string]: QueryValue
  readonly notify_user?: boolean
  readonly notify_ws_admins?: boolean
}
