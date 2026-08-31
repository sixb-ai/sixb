import { z } from "zod"

export const AuthInvitationStatusSchema = z.enum(["pending", "accepted", "revoked"])

export const AuthGroupOptionSchema = z.object({
  id: z.string(),
  label: z.string().optional(),
  description: z.string().optional(),
})

export const AuthInvitationSchema = z.object({
  id: z.string(),
  email: z.string(),
  groupIds: z.array(z.string()),
  status: AuthInvitationStatusSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
  expiresAt: z.string(),
  acceptedAt: z.string().optional(),
  revokedAt: z.string().optional(),
})

export const AuthInvitationDeliverySchema = z.object({
  status: z.enum(["sent", "skipped", "rate_limited", "not_supported"]),
  link: z
    .object({
      url: z.string().url(),
      expiresAt: z.string().optional(),
    })
    .optional(),
})

export const AuthInvitationGroupOptionSchema = AuthGroupOptionSchema

export const AuthAccessTokenKindSchema = z.enum(["personal", "serviceAccount"])
export const AuthAccessTokenSubjectTypeSchema = z.enum(["user", "serviceAccount"])
export const AuthAccessTokenStatusSchema = z.enum(["active", "expired", "revoked"])
export const AuthServiceAccountStatusSchema = z.enum(["active", "suspended"])
export const AuthUserStatusSchema = z.enum(["active", "suspended"])

export const AuthAccessTokenSchema = z.object({
  id: z.string(),
  name: z.string(),
  kind: AuthAccessTokenKindSchema,
  status: AuthAccessTokenStatusSchema,
  subjectType: AuthAccessTokenSubjectTypeSchema,
  subjectId: z.string(),
  subjectLabel: z.string().optional(),
  groupIds: z.array(z.string()).optional(),
  createdAt: z.string(),
  expiresAt: z.string(),
  revokedAt: z.string().optional(),
  lastUsedAt: z.string().optional(),
  lastUsedUserAgent: z.string().optional(),
  lastUsedIpAddress: z.string().optional(),
})

export const AuthServiceAccountSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().optional(),
  status: AuthServiceAccountStatusSchema,
  groupIds: z.array(z.string()),
  createdAt: z.string(),
  updatedAt: z.string(),
})

export const AuthMemberUserSchema = z.object({
  id: z.string(),
  email: z.string(),
  displayName: z.string().optional(),
  avatarUrl: z.string().optional(),
  status: AuthUserStatusSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
})

export const AuthManagedMemberSchema = z.object({
  user: AuthMemberUserSchema,
  groupIds: z.array(z.string()),
})

export const AuthMemberCapabilitiesSchema = z.object({
  assignGroups: z.boolean(),
  suspend: z.boolean(),
  reactivate: z.boolean(),
})

export const AuthMemberSchema = AuthManagedMemberSchema.extend({
  capabilities: AuthMemberCapabilitiesSchema,
})

export const GetAuthAccessManagementOptionsResponseSchema = z.object({
  groups: z.array(AuthGroupOptionSchema),
})

export const ListAuthAccessTokensResponseSchema = z.object({
  accessTokens: z.array(AuthAccessTokenSchema),
})

export const CreateAuthPersonalAccessTokenBodySchema = z.object({
  name: z.string().trim().min(1),
  expiresAt: z.string().min(1),
  groupIds: z.array(z.string().min(1)).optional(),
})

export const CreateAuthPersonalAccessTokenResponseSchema = z.object({
  accessToken: AuthAccessTokenSchema,
  tokenValue: z.string(),
})

export const RevokeAuthAccessTokenParamsSchema = z.object({
  tokenId: z.string().min(1),
})

export const RevokeAuthAccessTokenResponseSchema = z.object({
  accessToken: AuthAccessTokenSchema,
})

export const ListAuthServiceAccountsResponseSchema = z.object({
  serviceAccounts: z.array(AuthServiceAccountSchema),
})

export const CreateAuthServiceAccountBodySchema = z.object({
  id: z.string().trim().min(1).optional(),
  name: z.string().trim().min(1),
  description: z.string().trim().optional(),
  groupIds: z.array(z.string().min(1)).optional(),
})

export const CreateAuthServiceAccountResponseSchema = z.object({
  serviceAccount: AuthServiceAccountSchema,
})

export const AuthServiceAccountParamsSchema = z.object({
  serviceAccountId: z.string().min(1),
})

export const DisableAuthServiceAccountResponseSchema = z.object({
  serviceAccount: AuthServiceAccountSchema,
})

export const ListAuthServiceAccountAccessTokensResponseSchema = z.object({
  accessTokens: z.array(AuthAccessTokenSchema),
})

export const CreateAuthServiceAccountAccessTokenBodySchema = z.object({
  name: z.string().trim().min(1),
  expiresAt: z.string().min(1),
  groupIds: z.array(z.string().min(1)).optional(),
})

export const CreateAuthServiceAccountAccessTokenResponseSchema = z.object({
  accessToken: AuthAccessTokenSchema,
  tokenValue: z.string(),
})

export const RevokeAuthServiceAccountAccessTokenParamsSchema =
  AuthServiceAccountParamsSchema.extend({
    tokenId: z.string().min(1),
  })

export const RevokeAuthServiceAccountAccessTokenResponseSchema = z.object({
  accessToken: AuthAccessTokenSchema,
})

export const AuthCreateInvitationCapabilitySchema = z.union([
  z.object({
    state: z.literal("enabled"),
  }),
  z.object({
    state: z.literal("disabled"),
    reason: z.enum(["missing_membership_policy", "invitation_delivery_not_supported"]),
  }),
])

export const AuthInvitationDestinationSchema = z.object({
  id: z.enum(["atlas", "app"]),
  label: z.string(),
})

export const GetAuthInvitationOptionsResponseSchema = z.object({
  groups: z.array(AuthInvitationGroupOptionSchema),
  destinations: z.array(AuthInvitationDestinationSchema),
  defaultDestinationId: z.enum(["atlas", "app"]).optional(),
  canInviteWithoutGroups: z.boolean(),
  capabilities: z.object({
    createInvitation: AuthCreateInvitationCapabilitySchema,
  }),
})

export const GetAuthMembershipOptionsResponseSchema = z.object({
  groups: z.array(AuthGroupOptionSchema),
  capabilities: z.object({
    invite: z.boolean(),
    assignGroups: z.boolean(),
    suspend: z.boolean(),
  }),
})

export const ListAuthMembersQuerySchema = z.object({
  limit: z.string().optional(),
  offset: z.string().optional(),
  order: z.enum(["asc", "desc"]).optional(),
})

export const ListAuthMembersResponseSchema = z.object({
  members: z.array(AuthMemberSchema),
  hasMore: z.boolean(),
  total: z.number(),
})

export const AuthMemberParamsSchema = z.object({
  userId: z.string().min(1),
})

export const UpdateAuthMemberGroupsBodySchema = z.object({
  groupIds: z.array(z.string().min(1)),
})

export const UpdateAuthMemberGroupsResponseSchema = z.object({
  member: AuthManagedMemberSchema,
})

export const SuspendAuthMemberResponseSchema = z.object({
  member: AuthManagedMemberSchema,
})

export const ReactivateAuthMemberResponseSchema = z.object({
  member: AuthManagedMemberSchema,
})

export const CreateAuthInvitationBodySchema = z.object({
  email: z.string().min(1),
  groupIds: z.array(z.string().min(1)).optional(),
  destinationId: z.enum(["atlas", "app"]).optional(),
  expiresAt: z.string().optional(),
  returnTo: z.string().optional(),
  revealLink: z.boolean().optional(),
})

export const CreateAuthInvitationResponseSchema = z.object({
  invitation: AuthInvitationSchema,
  delivery: AuthInvitationDeliverySchema,
})

export const ListAuthInvitationsQuerySchema = z.object({
  email: z.string().optional(),
  status: AuthInvitationStatusSchema.optional(),
  limit: z.string().optional(),
  offset: z.string().optional(),
  order: z.enum(["asc", "desc"]).optional(),
})

export const ListAuthInvitationsResponseSchema = z.object({
  invitations: z.array(AuthInvitationSchema),
  hasMore: z.boolean(),
  total: z.number(),
})

export const RevokeAuthInvitationParamsSchema = z.object({
  invitationId: z.string().min(1),
})

export const RevokeAuthInvitationResponseSchema = z.object({
  invitation: AuthInvitationSchema,
})

export const AuthSessionResponseSchema = z.union([
  z.object({
    authenticated: z.literal(false),
  }),
  z.object({
    authenticated: z.literal(true),
    csrfToken: z.string(),
    applicationAccess: z.object({
      allowed: z.boolean(),
      audience: z.enum(["atlas", "app"]),
    }),
    user: z.object({
      id: z.string(),
      email: z.string(),
      displayName: z.string().optional(),
      avatarUrl: z.string().optional(),
      groupIds: z.array(z.string()),
    }),
    session: z.object({
      id: z.string(),
      expiresAt: z.string(),
    }),
  }),
])

export const AuthSignOutResponseSchema = z.object({
  success: z.boolean(),
})

export const AuthSessionSummarySchema = z.object({
  id: z.string(),
  audience: z.enum(["atlas", "app"]),
  current: z.boolean(),
  createdAt: z.string(),
  expiresAt: z.string(),
  lastSeenAt: z.string().optional(),
  userAgent: z.string().optional(),
  ipAddress: z.string().optional(),
})

export const ListAuthSessionsResponseSchema = z.object({
  sessions: z.array(AuthSessionSummarySchema),
})

export const RevokeAuthSessionParamsSchema = z.object({
  sessionId: z.string().min(1),
})

export const RevokeAuthSessionResponseSchema = z.object({
  success: z.boolean(),
})

export const SignOutAllResponseSchema = z.object({
  success: z.boolean(),
  revokedCount: z.number(),
})
