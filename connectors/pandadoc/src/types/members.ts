import type { PandaDocJsonObject } from "./common"

export interface PandaDocMember extends PandaDocJsonObject {
  readonly user_id?: string
  readonly membership_id: string
  readonly email?: string
  readonly first_name?: string
  readonly last_name?: string
  readonly workspace?: PandaDocJsonObject
  readonly role?: string
}

export interface PandaDocMemberTokenInput extends PandaDocJsonObject {}

export interface PandaDocMemberToken extends PandaDocJsonObject {
  readonly token?: string
}
