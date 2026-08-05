import type { GitHubPage, GitHubPaginationOptions, GitHubUser } from "./common"

export type GitHubOrganizationMemberFilter = "all" | "2fa_disabled" | "2fa_insecure"
export type GitHubOrganizationMemberRole = "all" | "admin" | "member"
export type GitHubOrganizationMembershipRole = "admin" | "member" | "billing_manager"
export type GitHubOrganizationMembershipState = "active" | "pending"

export interface ListOrganizationMembersOptions extends GitHubPaginationOptions {
  readonly filter?: GitHubOrganizationMemberFilter
  readonly role?: GitHubOrganizationMemberRole
}

export interface GitHubOrganizationSummary {
  readonly login: string
  readonly id: number
  readonly node_id: string
  readonly url: string
  readonly repos_url: string
  readonly events_url: string
  readonly hooks_url: string
  readonly issues_url: string
  readonly members_url: string
  readonly public_members_url: string
  readonly avatar_url: string
  readonly description: string | null
}

export interface GitHubOrganizationMembership {
  readonly url: string
  readonly state: GitHubOrganizationMembershipState
  readonly role: GitHubOrganizationMembershipRole
  readonly organization_url: string
  readonly direct_membership?: boolean
  readonly enterprise_teams_providing_indirect_membership?: readonly string[]
  readonly permissions?: {
    readonly can_create_repository: boolean
  }
  readonly organization: GitHubOrganizationSummary
  readonly user: GitHubUser | null
}

export interface ListAuthenticatedUserOrganizationMembershipsOptions
  extends GitHubPaginationOptions {
  readonly state?: GitHubOrganizationMembershipState
}

export interface AuthenticatedUserOrganizationMembershipsApi {
  /** List one page of organization memberships for the authenticated user. */
  list(
    options?: ListAuthenticatedUserOrganizationMembershipsOptions
  ): Promise<GitHubPage<GitHubOrganizationMembership>>
  /** Get the authenticated user's membership in an organization. */
  get(org: string): Promise<GitHubOrganizationMembership>
}

export interface OrganizationMembersApi {
  /** List one page of members. Private members are included when GitHub permits it. */
  list(options?: ListOrganizationMembersOptions): Promise<GitHubPage<GitHubUser>>
  /** List one page of members who have publicized their organization membership. */
  listPublic(options?: GitHubPaginationOptions): Promise<GitHubPage<GitHubUser>>
  /** Check public or private organization membership without turning a 404 into an error. */
  check(username: string): Promise<boolean>
  /** Check whether a user has publicized their organization membership. */
  checkPublic(username: string): Promise<boolean>
  /** Get a user's detailed organization membership. */
  getMembership(username: string): Promise<GitHubOrganizationMembership>
}

export interface ListOutsideCollaboratorsOptions extends GitHubPaginationOptions {
  readonly filter?: GitHubOrganizationMemberFilter
}

export interface OrganizationOutsideCollaboratorsApi {
  /** List one page of users who collaborate on organization repositories without membership. */
  list(options?: ListOutsideCollaboratorsOptions): Promise<GitHubPage<GitHubUser>>
}

export type GitHubOrganizationInvitationRole =
  | "direct_member"
  | "admin"
  | "billing_manager"
  | "hiring_manager"
export type GitHubOrganizationInvitationSource = "member" | "scim"

export interface ListOrganizationInvitationsOptions extends GitHubPaginationOptions {
  readonly role?: "all" | GitHubOrganizationInvitationRole
  readonly invitationSource?: "all" | GitHubOrganizationInvitationSource
}

export interface GitHubOrganizationInvitation {
  readonly id: number
  readonly login: string | null
  readonly node_id: string
  readonly email: string | null
  readonly role: GitHubOrganizationInvitationRole
  readonly created_at: string
  readonly inviter: GitHubUser
  readonly team_count: number
  readonly invitation_teams_url: string
  readonly invitation_source?: GitHubOrganizationInvitationSource
  readonly failed_at?: string | null
  readonly failed_reason?: string | null
}

export interface OrganizationInvitationsApi {
  /** List one page of pending organization invitations. */
  list(
    options?: ListOrganizationInvitationsOptions
  ): Promise<GitHubPage<GitHubOrganizationInvitation>>
}
