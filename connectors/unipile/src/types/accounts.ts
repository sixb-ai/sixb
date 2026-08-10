import type { UnipileCursorOptions, UnipileCursorPage, UnipileTimestamp } from "./common"

export type UnipileAccountStatus =
  | "OK"
  | "STOPPED"
  | "ERROR"
  | "CREDENTIALS"
  | "PERMISSIONS"
  | "CONNECTING"
  | (string & {})

export interface UnipileAccountSource {
  readonly id: string
  readonly status: UnipileAccountStatus
}

/** Common account fields. Provider-specific fields are returned without transformation. */
export interface UnipileAccount {
  readonly object: "Account"
  readonly id: string
  readonly name: string
  readonly type: string
  readonly created_at: UnipileTimestamp
  readonly sources: readonly UnipileAccountSource[]
  readonly groups?: readonly string[]
  readonly connection_params?: Readonly<Record<string, unknown>>
  readonly [key: string]: unknown
}

export interface UnipileLinkedinConnectionParams {
  readonly id: string
  readonly username: string
  readonly premiumContractId?: string | null
  readonly premiumFeatures?: readonly ("premium" | "recruiter" | "sales_navigator")[]
  readonly [key: string]: unknown
}

export interface UnipileLinkedinAccount extends UnipileAccount {
  readonly type: "LINKEDIN"
  readonly connection_params: {
    readonly im: UnipileLinkedinConnectionParams
    readonly [key: string]: unknown
  }
}

export type UnipileAccountsResponse = UnipileCursorPage<UnipileAccount>
export type UnipileAccountListOptions = UnipileCursorOptions

export type UnipileHostedAuthProvider =
  | "LINKEDIN"
  | "WHATSAPP"
  | "INSTAGRAM"
  | "MESSENGER"
  | "TELEGRAM"
  | "GOOGLE"
  | "MICROSOFT"
  | "OUTLOOK"
  | "MAIL"
  | (string & {})

export type UnipileHostedAuthDisabledFeature =
  | "linkedin_recruiter"
  | "linkedin_sales_navigator"
  | "linkedin_organizations_mailboxes"

export interface UnipileMessagingSyncLimit {
  readonly chats?: number | UnipileTimestamp
  readonly messages?: number | UnipileTimestamp
}

interface UnipileHostedAuthBaseInput {
  readonly expiresOn: UnipileTimestamp
  /** Defaults to the connector DSN. */
  readonly api_url?: string
  readonly name?: string
  readonly success_redirect_url?: string
  readonly failure_redirect_url?: string
  readonly notify_url?: string
  readonly disabled_features?: readonly UnipileHostedAuthDisabledFeature[]
  readonly sync_limit?: {
    readonly MESSAGING?: UnipileMessagingSyncLimit
  }
}

export interface UnipileCreateHostedAuthLinkInput extends UnipileHostedAuthBaseInput {
  readonly type: "create"
  readonly providers: "*" | "*:MESSAGING" | "*:MAILING" | readonly UnipileHostedAuthProvider[]
}

export interface UnipileReconnectHostedAuthLinkInput extends UnipileHostedAuthBaseInput {
  readonly type: "reconnect"
  readonly reconnect_account: string
}

export type UnipileHostedAuthLinkInput =
  | UnipileCreateHostedAuthLinkInput
  | UnipileReconnectHostedAuthLinkInput

export interface UnipileHostedAuthLink {
  /** Both spellings have appeared in Unipile's v1 documentation and SDK. */
  readonly object: "HostedAuthURL" | "HostedAuthUrl"
  readonly url: string
}
