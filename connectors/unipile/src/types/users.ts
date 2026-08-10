import type { UnipileCursorOptions, UnipileCursorPage } from "./common"

export type UnipileLinkedinApi = "classic" | "sales_navigator" | "recruiter"

export type UnipileLinkedinSection =
  | "experience"
  | "education"
  | "languages"
  | "skills"
  | "certifications"
  | "about"
  | "*_preview"
  | "*"

export interface UnipileGetProfileOptions {
  readonly account_id: string
  readonly linkedin_api?: UnipileLinkedinApi
  readonly linkedin_sections?: UnipileLinkedinSection | readonly UnipileLinkedinSection[]
  /** Whether LinkedIn should notify the profile owner of the visit. Defaults to false upstream. */
  readonly notify?: boolean
}

export interface UnipileLinkedinExperience {
  readonly position?: string
  readonly role?: string
  readonly company_id?: string | null
  readonly company: string
  readonly location?: string | null
  readonly description?: string | null
  readonly start?: string | { readonly year?: number; readonly month?: number } | null
  readonly end?: string | { readonly year?: number; readonly month?: number } | null
  readonly [key: string]: unknown
}

export interface UnipileLinkedinEducation {
  readonly school: string
  readonly school_id?: string | null
  readonly degree?: string | null
  readonly field_of_study?: string | null
  readonly start?: string | { readonly year?: number; readonly month?: number } | null
  readonly end?: string | { readonly year?: number; readonly month?: number } | null
  readonly [key: string]: unknown
}

export interface UnipileLinkedinProfile {
  readonly object: "UserProfile"
  readonly provider: "LINKEDIN"
  readonly provider_id: string
  readonly public_identifier: string | null
  readonly member_urn?: string | null
  readonly first_name: string | null
  readonly last_name: string | null
  readonly headline: string
  readonly summary?: string
  readonly location?: string
  readonly websites?: readonly string[]
  readonly profile_picture_url?: string
  readonly profile_picture_url_large?: string
  readonly background_picture_url?: string
  readonly is_open_profile?: boolean
  readonly can_send_inmail?: boolean
  readonly is_premium?: boolean
  readonly is_influencer?: boolean
  readonly is_creator?: boolean
  readonly is_relationship?: boolean
  readonly is_self?: boolean
  readonly follower_count?: number
  readonly connections_count?: number
  readonly shared_connections_count?: number
  readonly network_distance?: string
  readonly invitation?: {
    readonly type: "SENT" | "RECEIVED"
    readonly status: "PENDING" | "IGNORED" | "WITHDRAWN" | (string & {})
  }
  readonly work_experience?: readonly UnipileLinkedinExperience[]
  readonly education?: readonly UnipileLinkedinEducation[]
  readonly skills?: readonly unknown[]
  readonly languages?: readonly unknown[]
  readonly certifications?: readonly unknown[]
  readonly throttled_sections?: readonly string[]
  readonly [key: string]: unknown
}

export interface UnipileSendInvitationInput {
  readonly account_id: string
  readonly provider_id: string
  readonly user_email?: string
  /** LinkedIn permits at most 300 characters through this endpoint. */
  readonly message?: string
}

export interface UnipileInvitationSent {
  readonly object: "UserInvitationSent"
  readonly invitation_id: string
}

export interface UnipileRelation {
  readonly object: "UserRelation"
  readonly first_name: string
  readonly last_name: string
  readonly headline: string
  readonly public_identifier: string
  readonly public_profile_url: string
  readonly created_at: number
  readonly member_id: string
  readonly member_urn: string
  readonly connection_urn: string
  readonly profile_picture_url?: string
  readonly provider_id?: string
  readonly [key: string]: unknown
}

export interface UnipileRelationListOptions extends UnipileCursorOptions {
  readonly account_id: string
}

export type UnipileRelationsResponse = UnipileCursorPage<UnipileRelation>
