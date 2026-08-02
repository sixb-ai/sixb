import { createHash, randomBytes, timingSafeEqual } from "node:crypto"
import type { AuthSessionAudience, GroupDefinition, OntologySource, Sixb } from "@sixb/core"
import { SixbValidationError, toSixbFailure } from "@sixb/core/errors"
import {
  type AuthenticatedUserRequestSession,
  type AuthRequestResult,
  clearCsrfCookieHeader,
  clearSessionCookieHeader,
  createCsrfCookieHeader,
  createSessionCookieHeader,
  createSessionCredential,
  generateCsrfToken,
  getCookie,
  isMagicLinkAuthStrategy,
  isOidcAuthStrategy,
  type MagicLinkAuthStrategy,
  type MemberSummary,
  shouldUseSecureCookies,
  verifyDoubleSubmitCsrf,
} from "@sixb/core/internal/auth"
import {
  type AccessTokenRecord,
  type AuthStorage,
  AuthStorageError,
  type InvitationRecord,
  type ServiceAccountRecord,
  type UserRecord,
} from "@sixb/core/storage"
import { type Elysia, t } from "elysia"
import { bearerSecurityRequirement } from "../auth/access-token-boundary"
import { sessionCanAccessApplication } from "../auth/application-access"
import {
  type AuthInvitationDestinationOptions,
  type AuthInvitationRedirectContext,
  type AuthInvitationRedirectInput,
  type AuthRedirectContext,
  BrowserOriginError,
  type ResolveAuthRedirectContext,
  type ResolveRequestAuthContext,
} from "../auth/browser-origin"
import { CSRF_TOKEN_RESPONSE_HEADER_NAME } from "../auth/csrf"
import { jsonErrorResponse } from "../auth/responses"
import { hasForegroundSessionActivity } from "../auth/session-activity"
import { createSessionRenewalCookieHeaders } from "../auth/session-cookies"
import { SIXB_CSRF_SECURITY_REQUIREMENT } from "../openapi/security"
import { OPENAPI_TAGS } from "../openapi/tags"
import {
  AuthMemberParamsSchema,
  AuthServiceAccountParamsSchema,
  AuthSessionResponseSchema,
  AuthSignOutResponseSchema,
  CreateAuthInvitationBodySchema,
  CreateAuthInvitationResponseSchema,
  CreateAuthPersonalAccessTokenBodySchema,
  CreateAuthPersonalAccessTokenResponseSchema,
  CreateAuthServiceAccountAccessTokenBodySchema,
  CreateAuthServiceAccountAccessTokenResponseSchema,
  CreateAuthServiceAccountBodySchema,
  CreateAuthServiceAccountResponseSchema,
  DisableAuthServiceAccountResponseSchema,
  GetAuthAccessManagementOptionsResponseSchema,
  GetAuthInvitationOptionsResponseSchema,
  GetAuthMembershipOptionsResponseSchema,
  ListAuthAccessTokensResponseSchema,
  ListAuthInvitationsQuerySchema,
  ListAuthInvitationsResponseSchema,
  ListAuthMembersQuerySchema,
  ListAuthMembersResponseSchema,
  ListAuthServiceAccountAccessTokensResponseSchema,
  ListAuthServiceAccountsResponseSchema,
  ListAuthSessionsResponseSchema,
  ReactivateAuthMemberResponseSchema,
  RevokeAuthAccessTokenParamsSchema,
  RevokeAuthAccessTokenResponseSchema,
  RevokeAuthInvitationParamsSchema,
  RevokeAuthInvitationResponseSchema,
  RevokeAuthServiceAccountAccessTokenParamsSchema,
  RevokeAuthServiceAccountAccessTokenResponseSchema,
  RevokeAuthSessionParamsSchema,
  RevokeAuthSessionResponseSchema,
  SignOutAllResponseSchema,
  SuspendAuthMemberResponseSchema,
  UpdateAuthMemberGroupsBodySchema,
  UpdateAuthMemberGroupsResponseSchema,
} from "../schemas/auth"
import { ErrorResponseSchema } from "../schemas/common"
import { parseDate, parseOptionalInt, toIsoString } from "../utils/http"

type ResolvedCookieOptions = Parameters<typeof createCsrfCookieHeader>[0]["options"]
type AuthenticatedAuthSessionResponse = {
  readonly authenticated: true
  readonly csrfToken: string
  readonly applicationAccess: {
    readonly allowed: boolean
    readonly audience: AuthSessionAudience
  }
  readonly user: {
    readonly id: string
    readonly email: string
    readonly displayName?: string
    readonly avatarUrl?: string
    readonly groupIds: readonly string[]
  }
  readonly session: {
    readonly id: string
    readonly expiresAt: string
  }
}

export interface AuthRoutesOptions {
  readonly resolveAuthContext: ResolveRequestAuthContext
  readonly resolveAuthRedirectContext: ResolveAuthRedirectContext
  readonly getInvitationDestinationOptions: (request: Request) => AuthInvitationDestinationOptions
  readonly resolveAuthRequestOrigin: (request: Request) => string
  readonly resolveInvitationRedirectContext: (
    request: Request,
    input: AuthInvitationRedirectInput
  ) => AuthInvitationRedirectContext
}

export function registerAuthRoutes(
  app: Elysia,
  sixb: Sixb<readonly OntologySource[]>,
  options: AuthRoutesOptions
) {
  return app
    .get(
      "/api/auth/session",
      async ({ request }) => {
        const authOptions = resolveAuthOptions(options, request)
        let session = await sixb.auth.getSession(request, authOptions)
        if (!session.authenticated) {
          return jsonResponse({ authenticated: false as const }, 200)
        }

        let applicationAccessAllowed = sessionCanAccessApplication(
          sixb,
          session,
          authOptions.audience
        )
        if (applicationAccessAllowed && hasForegroundSessionActivity(request)) {
          session = await sixb.auth.getSession(request, {
            ...authOptions,
            sessionActivity: "foreground",
          })
          if (!session.authenticated) {
            return jsonResponse({ authenticated: false as const }, 200)
          }
          applicationAccessAllowed = sessionCanAccessApplication(
            sixb,
            session,
            authOptions.audience
          )
        }

        const cookieOptions = sixb.auth.getCookieOptions(authOptions)
        const csrf = resolveSessionCsrfToken({
          request,
          cookieOptions,
          expiresAt: session.session.expiresAt,
        })
        const renewal =
          session.sessionRenewed === true
            ? createSessionRenewalCookieHeaders({
                sixb,
                request,
                session,
                csrfToken: csrf.token,
              })
            : null
        return authSessionJsonResponse(
          {
            authenticated: true as const,
            csrfToken: csrf.token,
            applicationAccess: {
              allowed: applicationAccessAllowed,
              audience: authOptions.audience,
            },
            user: {
              id: session.user.id,
              email: session.user.email,
              displayName: session.user.displayName,
              avatarUrl: session.user.avatarUrl,
              groupIds: [...session.groupIds],
            },
            session: {
              id: session.session.id,
              expiresAt: toIsoString(session.session.expiresAt),
            },
          },
          renewal?.headers ?? (csrf.setCookie ? [csrf.setCookie] : [])
        )
      },
      {
        response: { 200: AuthSessionResponseSchema },
        detail: {
          summary: "Get current auth session",
          tags: [OPENAPI_TAGS.authSessions.name],
          operationId: "getAuthSession",
        },
      }
    )
    .post(
      "/api/auth/sign-out",
      async ({ request }) => {
        const authOptions = resolveAuthOptions(options, request)
        const session = await sixb.auth.getSession(request, authOptions)
        const cookieOptions = sixb.auth.getCookieOptions(authOptions)
        if (
          session.authenticated &&
          !verifyDoubleSubmitCsrf(request, {
            cookieName: cookieOptions.csrfCookieName,
          })
        ) {
          return jsonErrorResponse("auth.csrf_rejected", "CSRF verification failed")
        }

        if (session.authenticated) {
          await sixb.storage.auth?.sessions.revoke({
            projectId: sixb.id,
            id: session.session.id,
            revokedAt: new Date(),
          })
          // Drop the cached session immediately so it isn't honored for the cache TTL.
          sixb.auth.invalidateSession(session.session.id)
        }

        const headers = new Headers({ "content-type": "application/json; charset=utf-8" })
        headers.append("set-cookie", clearSessionCookieHeader({ request, options: cookieOptions }))
        headers.append("set-cookie", clearCsrfCookieHeader({ request, options: cookieOptions }))

        return new Response(JSON.stringify({ success: true }), {
          status: 200,
          headers,
        })
      },
      {
        response: {
          200: AuthSignOutResponseSchema,
          403: ErrorResponseSchema,
        },
        detail: {
          summary: "Sign out current auth session",
          tags: [OPENAPI_TAGS.authSessions.name],
          operationId: "signOut",
          security: SIXB_CSRF_SECURITY_REQUIREMENT,
        },
      }
    )
    .get(
      "/api/auth/sessions",
      async ({ request }) => {
        const authOptions = resolveAuthOptions(options, request)
        const session = await sixb.auth.getSession(request, authOptions)
        if (!session.authenticated) {
          return jsonErrorResponse("auth.authentication_required", "Authentication required")
        }

        const sessions = await requireAuthStorage(sixb).sessions.listActiveByUserId({
          projectId: sixb.id,
          userId: session.user.id,
          now: new Date(),
        })

        return jsonResponse(
          {
            sessions: sessions.map((entry) => ({
              id: entry.id,
              audience: entry.audience,
              current: entry.id === session.session.id,
              createdAt: toIsoString(entry.createdAt),
              expiresAt: toIsoString(entry.expiresAt),
              lastSeenAt: entry.lastSeenAt ? toIsoString(entry.lastSeenAt) : undefined,
              userAgent: entry.userAgent,
              ipAddress: entry.ipAddress,
            })),
          },
          200
        )
      },
      {
        response: {
          200: ListAuthSessionsResponseSchema,
          401: ErrorResponseSchema,
        },
        detail: {
          summary: "List active sessions for the current user",
          tags: [OPENAPI_TAGS.authSessions.name],
          operationId: "listAuthSessions",
        },
      }
    )
    .post(
      "/api/auth/sessions/:sessionId/revoke",
      async ({ request, params }) => {
        const authOptions = resolveAuthOptions(options, request)
        const session = await sixb.auth.getSession(request, authOptions)
        const cookieOptions = sixb.auth.getCookieOptions(authOptions)
        if (!session.authenticated) {
          return jsonErrorResponse("auth.authentication_required", "Authentication required")
        }
        if (!verifyDoubleSubmitCsrf(request, { cookieName: cookieOptions.csrfCookieName })) {
          return jsonErrorResponse("auth.csrf_rejected", "CSRF verification failed")
        }

        const { sessionId } = RevokeAuthSessionParamsSchema.parse(params)
        const storage = requireAuthStorage(sixb)
        const target = await storage.sessions.getById({ projectId: sixb.id, id: sessionId })
        // Only the caller's own sessions are revocable. A missing or foreign
        // session id returns the same 404 so it cannot probe other accounts.
        if (!target || target.userId !== session.user.id) {
          return jsonErrorResponse("auth.record_not_found", "Session not found")
        }

        await storage.sessions.revoke({ projectId: sixb.id, id: sessionId, revokedAt: new Date() })
        sixb.auth.invalidateSession(sessionId)

        const headers = new Headers({ "content-type": "application/json; charset=utf-8" })
        // Revoking the session backing this request also clears its cookies.
        if (sessionId === session.session.id) {
          headers.append(
            "set-cookie",
            clearSessionCookieHeader({ request, options: cookieOptions })
          )
          headers.append("set-cookie", clearCsrfCookieHeader({ request, options: cookieOptions }))
        }

        return new Response(JSON.stringify({ success: true }), { status: 200, headers })
      },
      {
        params: RevokeAuthSessionParamsSchema,
        response: {
          200: RevokeAuthSessionResponseSchema,
          401: ErrorResponseSchema,
          403: ErrorResponseSchema,
          404: ErrorResponseSchema,
        },
        detail: {
          summary: "Revoke one of the current user's sessions",
          tags: [OPENAPI_TAGS.authSessions.name],
          operationId: "revokeAuthSession",
          security: SIXB_CSRF_SECURITY_REQUIREMENT,
        },
      }
    )
    .post(
      "/api/auth/sign-out-all",
      async ({ request }) => {
        const authOptions = resolveAuthOptions(options, request)
        const session = await sixb.auth.getSession(request, authOptions)
        const cookieOptions = sixb.auth.getCookieOptions(authOptions)
        if (!session.authenticated) {
          return jsonErrorResponse("auth.authentication_required", "Authentication required")
        }
        if (!verifyDoubleSubmitCsrf(request, { cookieName: cookieOptions.csrfCookieName })) {
          return jsonErrorResponse("auth.csrf_rejected", "CSRF verification failed")
        }

        // Global sign-out: revoke every active session for the user across all
        // audiences. Other audiences' cookies remain client-side but their
        // sessions are revoked, so the next request re-authenticates.
        const revoked = await requireAuthStorage(sixb).sessions.revokeActiveForUser({
          projectId: sixb.id,
          userId: session.user.id,
          revokedAt: new Date(),
        })
        for (const revokedSession of revoked) {
          sixb.auth.invalidateSession(revokedSession.id)
        }

        const headers = new Headers({ "content-type": "application/json; charset=utf-8" })
        headers.append("set-cookie", clearSessionCookieHeader({ request, options: cookieOptions }))
        headers.append("set-cookie", clearCsrfCookieHeader({ request, options: cookieOptions }))

        return new Response(JSON.stringify({ success: true, revokedCount: revoked.length }), {
          status: 200,
          headers,
        })
      },
      {
        response: {
          200: SignOutAllResponseSchema,
          401: ErrorResponseSchema,
          403: ErrorResponseSchema,
        },
        detail: {
          summary: "Sign out the current user everywhere (all devices and apps)",
          tags: [OPENAPI_TAGS.authSessions.name],
          operationId: "signOutAll",
          security: SIXB_CSRF_SECURITY_REQUIREMENT,
        },
      }
    )
    .get(
      "/api/auth/access-management-options",
      async ({ request }) => {
        try {
          const authOptions = resolveAuthOptions(options, request)
          const session = requireAuthenticatedUserSession(
            await sixb.auth.getSession(request, {
              ...authOptions,
              credentialSource: "any",
            })
          )
          if (session instanceof Response) {
            return session
          }

          const assignableGroupIds = new Set(session.groupIds)

          return jsonResponse(
            {
              groups: sixb.security
                .listGroups()
                // V1 avoids privilege escalation by only offering groups the
                // current session already has. Runtime token auth still
                // intersects groups at request time as a second boundary.
                .filter((group) => assignableGroupIds.has(group.id))
                .map(serializeGroupOption),
            },
            200
          )
        } catch (error) {
          return authRouteErrorResponse(error)
        }
      },
      {
        response: {
          200: GetAuthAccessManagementOptionsResponseSchema,
          401: ErrorResponseSchema,
          500: ErrorResponseSchema,
        },
        detail: {
          summary: "Get auth access-token management options",
          tags: [OPENAPI_TAGS.authAccessTokens.name],
          operationId: "getAuthAccessManagementOptions",
          security: bearerSecurityRequirement("getAuthAccessManagementOptions"),
        },
      }
    )
    .get(
      "/api/auth/access-tokens",
      async ({ request }) => {
        try {
          const authOptions = resolveAuthOptions(options, request)
          const session = requireAuthenticatedUserSession(
            await sixb.auth.getSession(request, {
              ...authOptions,
              credentialSource: "any",
            })
          )
          if (session instanceof Response) {
            return session
          }

          const { accessTokens } = await sixb.auth.listPersonalAccessTokens(request, authOptions)

          return jsonResponse(
            {
              accessTokens: accessTokens.map((accessToken) =>
                serializeAccessToken(accessToken, { subjectLabel: session.user.email })
              ),
            },
            200
          )
        } catch (error) {
          return authRouteErrorResponse(error)
        }
      },
      {
        response: {
          200: ListAuthAccessTokensResponseSchema,
          401: ErrorResponseSchema,
          500: ErrorResponseSchema,
        },
        detail: {
          summary: "List personal access tokens for the current user",
          tags: [OPENAPI_TAGS.authAccessTokens.name],
          operationId: "listAuthAccessTokens",
          security: bearerSecurityRequirement("listAuthAccessTokens"),
        },
      }
    )
    .post(
      "/api/auth/access-tokens",
      async ({ request, body }) => {
        try {
          const authOptions = resolveAuthOptions(options, request)
          const parsed = CreateAuthPersonalAccessTokenBodySchema.parse(body)
          const session = requireAuthenticatedUserSession(
            await sixb.auth.getSession(request, {
              ...authOptions,
              credentialSource: "any",
            })
          )
          if (session instanceof Response) {
            return session
          }

          const expiresAt = parseRequiredFutureDate(parsed.expiresAt)
          const result = await sixb.auth.createPersonalAccessToken(
            request,
            { name: parsed.name, expiresAt, groupIds: parsed.groupIds },
            authOptions
          )

          // The raw token is only returned on creation. Storage keeps a hash, so
          // Atlas can never reveal it again after this response leaves the page.
          return jsonResponse(
            {
              accessToken: serializeAccessToken(result.accessToken, {
                subjectLabel: session.user.email,
              }),
              tokenValue: result.tokenValue,
            },
            201
          )
        } catch (error) {
          return authRouteErrorResponse(error)
        }
      },
      {
        body: CreateAuthPersonalAccessTokenBodySchema,
        response: {
          201: CreateAuthPersonalAccessTokenResponseSchema,
          400: ErrorResponseSchema,
          401: ErrorResponseSchema,
          403: ErrorResponseSchema,
          500: ErrorResponseSchema,
        },
        detail: {
          summary: "Create a personal access token",
          tags: [OPENAPI_TAGS.authAccessTokens.name],
          operationId: "createAuthPersonalAccessToken",
          security: bearerSecurityRequirement("createAuthPersonalAccessToken"),
        },
      }
    )
    .post(
      "/api/auth/access-tokens/:tokenId/revoke",
      async ({ request, params }) => {
        try {
          const authOptions = resolveAuthOptions(options, request)
          const session = requireAuthenticatedUserSession(
            await sixb.auth.getSession(request, {
              ...authOptions,
              credentialSource: "any",
            })
          )
          if (session instanceof Response) {
            return session
          }

          const { tokenId } = RevokeAuthAccessTokenParamsSchema.parse(params)
          const result = await sixb.auth.revokePersonalAccessToken(
            request,
            { tokenId },
            authOptions
          )
          return jsonResponse(
            {
              accessToken: serializeAccessToken(result.accessToken, {
                subjectLabel: session.user.email,
              }),
            },
            200
          )
        } catch (error) {
          return authRouteErrorResponse(error)
        }
      },
      {
        params: RevokeAuthAccessTokenParamsSchema,
        response: {
          200: RevokeAuthAccessTokenResponseSchema,
          401: ErrorResponseSchema,
          403: ErrorResponseSchema,
          404: ErrorResponseSchema,
          500: ErrorResponseSchema,
        },
        detail: {
          summary: "Revoke one of the current user's personal access tokens",
          tags: [OPENAPI_TAGS.authAccessTokens.name],
          operationId: "revokeAuthAccessToken",
          security: bearerSecurityRequirement("revokeAuthAccessToken"),
        },
      }
    )
    .get(
      "/api/auth/service-accounts",
      async ({ request }) => {
        try {
          const authOptions = resolveAuthOptions(options, request)
          const session = requireAuthenticatedUserSession(
            await sixb.auth.getSession(request, { ...authOptions, credentialSource: "any" })
          )
          if (session instanceof Response) return session

          const { serviceAccounts } = await sixb.auth.listServiceAccounts(request, authOptions)

          return jsonResponse(
            {
              serviceAccounts: serviceAccounts.map(({ serviceAccount, groupIds }) =>
                serializeServiceAccount(serviceAccount, groupIds)
              ),
            },
            200
          )
        } catch (error) {
          return authRouteErrorResponse(error)
        }
      },
      {
        response: {
          200: ListAuthServiceAccountsResponseSchema,
          401: ErrorResponseSchema,
          403: ErrorResponseSchema,
          500: ErrorResponseSchema,
        },
        detail: {
          summary: "List auth service accounts",
          tags: [OPENAPI_TAGS.authServiceAccounts.name],
          operationId: "listAuthServiceAccounts",
          security: bearerSecurityRequirement("listAuthServiceAccounts"),
        },
      }
    )
    .post(
      "/api/auth/service-accounts",
      async ({ request, body }) => {
        try {
          const authOptions = resolveAuthOptions(options, request)
          const parsed = CreateAuthServiceAccountBodySchema.parse(body)
          const session = requireAuthenticatedUserSession(
            await sixb.auth.getSession(request, { ...authOptions, credentialSource: "any" })
          )
          if (session instanceof Response) return session

          const result = await sixb.auth.createServiceAccount(
            request,
            {
              id: parsed.id,
              name: parsed.name,
              description: optionalTrimmed(parsed.description),
              groupIds: parsed.groupIds,
            },
            { ...authOptions, credentialSource: "any" }
          )

          return jsonResponse(
            {
              serviceAccount: serializeServiceAccount(
                result.serviceAccount,
                result.groupMemberships.map((membership) => membership.groupId)
              ),
            },
            201
          )
        } catch (error) {
          return authRouteErrorResponse(error)
        }
      },
      {
        body: CreateAuthServiceAccountBodySchema,
        response: {
          201: CreateAuthServiceAccountResponseSchema,
          400: ErrorResponseSchema,
          401: ErrorResponseSchema,
          403: ErrorResponseSchema,
          500: ErrorResponseSchema,
        },
        detail: {
          summary: "Create an auth service account",
          tags: [OPENAPI_TAGS.authServiceAccounts.name],
          operationId: "createAuthServiceAccount",
          security: bearerSecurityRequirement("createAuthServiceAccount"),
        },
      }
    )
    .post(
      "/api/auth/service-accounts/:serviceAccountId/disable",
      async ({ request, params }) => {
        try {
          const authOptions = resolveAuthOptions(options, request)
          const session = requireAuthenticatedUserSession(
            await sixb.auth.getSession(request, { ...authOptions, credentialSource: "any" })
          )
          if (session instanceof Response) return session

          const { serviceAccountId } = AuthServiceAccountParamsSchema.parse(params)
          const result = await sixb.auth.disableServiceAccount(
            request,
            { serviceAccountId },
            authOptions
          )

          return jsonResponse(
            {
              serviceAccount: serializeServiceAccount(result.serviceAccount, result.groupIds),
            },
            200
          )
        } catch (error) {
          return authRouteErrorResponse(error)
        }
      },
      {
        params: AuthServiceAccountParamsSchema,
        response: {
          200: DisableAuthServiceAccountResponseSchema,
          401: ErrorResponseSchema,
          403: ErrorResponseSchema,
          404: ErrorResponseSchema,
          500: ErrorResponseSchema,
        },
        detail: {
          summary: "Disable an auth service account",
          tags: [OPENAPI_TAGS.authServiceAccounts.name],
          operationId: "disableAuthServiceAccount",
          security: bearerSecurityRequirement("disableAuthServiceAccount"),
        },
      }
    )
    .get(
      "/api/auth/service-accounts/:serviceAccountId/access-tokens",
      async ({ request, params }) => {
        try {
          const authOptions = resolveAuthOptions(options, request)
          const session = requireAuthenticatedUserSession(
            await sixb.auth.getSession(request, { ...authOptions, credentialSource: "any" })
          )
          if (session instanceof Response) return session

          const { serviceAccountId } = AuthServiceAccountParamsSchema.parse(params)
          const { serviceAccount, accessTokens } = await sixb.auth.listServiceAccountAccessTokens(
            request,
            { serviceAccountId },
            authOptions
          )

          return jsonResponse(
            {
              accessTokens: accessTokens.map((accessToken) =>
                serializeAccessToken(accessToken, { subjectLabel: serviceAccount.name })
              ),
            },
            200
          )
        } catch (error) {
          return authRouteErrorResponse(error)
        }
      },
      {
        params: AuthServiceAccountParamsSchema,
        response: {
          200: ListAuthServiceAccountAccessTokensResponseSchema,
          401: ErrorResponseSchema,
          403: ErrorResponseSchema,
          404: ErrorResponseSchema,
          500: ErrorResponseSchema,
        },
        detail: {
          summary: "List access tokens for an auth service account",
          tags: [OPENAPI_TAGS.authServiceAccounts.name],
          operationId: "listAuthServiceAccountAccessTokens",
          security: bearerSecurityRequirement("listAuthServiceAccountAccessTokens"),
        },
      }
    )
    .post(
      "/api/auth/service-accounts/:serviceAccountId/access-tokens",
      async ({ request, params, body }) => {
        try {
          const authOptions = resolveAuthOptions(options, request)
          const parsedParams = AuthServiceAccountParamsSchema.parse(params)
          const parsed = CreateAuthServiceAccountAccessTokenBodySchema.parse(body)
          const session = requireAuthenticatedUserSession(
            await sixb.auth.getSession(request, { ...authOptions, credentialSource: "any" })
          )
          if (session instanceof Response) return session

          const expiresAt = parseRequiredFutureDate(parsed.expiresAt)
          const result = await sixb.auth.createServiceAccountAccessToken(
            request,
            {
              serviceAccountId: parsedParams.serviceAccountId,
              name: parsed.name,
              expiresAt,
              groupIds: parsed.groupIds,
            },
            { ...authOptions, credentialSource: "any" }
          )

          return jsonResponse(
            {
              accessToken: serializeAccessToken(result.accessToken, {
                subjectLabel: result.serviceAccount.name,
              }),
              tokenValue: result.tokenValue,
            },
            201
          )
        } catch (error) {
          return authRouteErrorResponse(error)
        }
      },
      {
        params: AuthServiceAccountParamsSchema,
        body: CreateAuthServiceAccountAccessTokenBodySchema,
        response: {
          201: CreateAuthServiceAccountAccessTokenResponseSchema,
          400: ErrorResponseSchema,
          401: ErrorResponseSchema,
          403: ErrorResponseSchema,
          404: ErrorResponseSchema,
          500: ErrorResponseSchema,
        },
        detail: {
          summary: "Create an access token for an auth service account",
          tags: [OPENAPI_TAGS.authServiceAccounts.name],
          operationId: "createAuthServiceAccountAccessToken",
          security: bearerSecurityRequirement("createAuthServiceAccountAccessToken"),
        },
      }
    )
    .post(
      "/api/auth/service-accounts/:serviceAccountId/access-tokens/:tokenId/revoke",
      async ({ request, params }) => {
        try {
          const authOptions = resolveAuthOptions(options, request)
          const parsed = RevokeAuthServiceAccountAccessTokenParamsSchema.parse(params)
          const session = requireAuthenticatedUserSession(
            await sixb.auth.getSession(request, { ...authOptions, credentialSource: "any" })
          )
          if (session instanceof Response) return session

          const result = await sixb.auth.revokeServiceAccountAccessToken(
            request,
            { serviceAccountId: parsed.serviceAccountId, tokenId: parsed.tokenId },
            authOptions
          )

          return jsonResponse(
            {
              accessToken: serializeAccessToken(result.accessToken, {
                subjectLabel: result.serviceAccount.name,
              }),
            },
            200
          )
        } catch (error) {
          return authRouteErrorResponse(error)
        }
      },
      {
        params: RevokeAuthServiceAccountAccessTokenParamsSchema,
        response: {
          200: RevokeAuthServiceAccountAccessTokenResponseSchema,
          401: ErrorResponseSchema,
          403: ErrorResponseSchema,
          404: ErrorResponseSchema,
          500: ErrorResponseSchema,
        },
        detail: {
          summary: "Revoke an access token for an auth service account",
          tags: [OPENAPI_TAGS.authServiceAccounts.name],
          operationId: "revokeAuthServiceAccountAccessToken",
          security: bearerSecurityRequirement("revokeAuthServiceAccountAccessToken"),
        },
      }
    )
    .post(
      "/api/auth/invitations",
      async ({ request, body }) => {
        try {
          const authOptions = resolveAuthOptions(options, request)
          const parsed = CreateAuthInvitationBodySchema.parse(body)
          const deliveryContext = resolveInvitationDeliveryContext(options, request, {
            destinationId: parsed.destinationId,
            returnTo: parsed.returnTo,
          })
          if (deliveryContext instanceof Response) {
            return deliveryContext
          }

          const result = await sixb.auth.invite(
            request,
            {
              email: parsed.email,
              groupIds: parsed.groupIds,
              expiresAt: parseDate(parsed.expiresAt),
              returnTo: deliveryContext.returnTo,
            },
            {
              ...authOptions,
              delivery: {
                audience: deliveryContext.audience,
                returnTo: deliveryContext.returnTo,
                requestOrigin: deliveryContext.requestOrigin,
              },
            }
          )

          return jsonResponse(
            {
              invitation: serializeInvitation(result.invitation),
              delivery: result.delivery,
            },
            201
          )
        } catch (error) {
          return authRouteErrorResponse(error)
        }
      },
      {
        body: CreateAuthInvitationBodySchema,
        response: {
          201: CreateAuthInvitationResponseSchema,
          400: ErrorResponseSchema,
          401: ErrorResponseSchema,
          403: ErrorResponseSchema,
          404: ErrorResponseSchema,
          429: ErrorResponseSchema,
          500: ErrorResponseSchema,
        },
        detail: {
          summary: "Create an auth invitation",
          tags: [OPENAPI_TAGS.authInvitations.name],
          operationId: "createAuthInvitation",
          security: SIXB_CSRF_SECURITY_REQUIREMENT,
        },
      }
    )
    .get(
      "/api/auth/invitation-options",
      async ({ request }) => {
        try {
          const authOptions = resolveAuthOptions(options, request)
          return jsonResponse(
            {
              ...(await sixb.auth.getInvitationOptions(request, authOptions)),
              ...options.getInvitationDestinationOptions(request),
            },
            200
          )
        } catch (error) {
          return authRouteErrorResponse(error)
        }
      },
      {
        response: {
          200: GetAuthInvitationOptionsResponseSchema,
          401: ErrorResponseSchema,
          500: ErrorResponseSchema,
        },
        detail: {
          summary: "Get auth invitation options",
          tags: [OPENAPI_TAGS.authInvitations.name],
          operationId: "getAuthInvitationOptions",
        },
      }
    )
    .get(
      "/api/auth/invitations",
      async ({ request, query }) => {
        try {
          const authOptions = resolveAuthOptions(options, request)
          const parsed = ListAuthInvitationsQuerySchema.parse(query)
          const result = await sixb.auth.listInvitations(
            request,
            {
              email: parsed.email,
              statuses: parsed.status ? [parsed.status] : undefined,
              limit: parseOptionalInt(parsed.limit),
              offset: parseOptionalInt(parsed.offset),
              order: parsed.order,
            },
            authOptions
          )

          return jsonResponse(
            {
              invitations: result.invitations.map(serializeInvitation),
              hasMore: result.hasMore,
              total: result.total,
            },
            200
          )
        } catch (error) {
          return authRouteErrorResponse(error)
        }
      },
      {
        query: ListAuthInvitationsQuerySchema,
        response: {
          200: ListAuthInvitationsResponseSchema,
          400: ErrorResponseSchema,
          401: ErrorResponseSchema,
          403: ErrorResponseSchema,
          404: ErrorResponseSchema,
          500: ErrorResponseSchema,
        },
        detail: {
          summary: "List auth invitations",
          tags: [OPENAPI_TAGS.authInvitations.name],
          operationId: "listAuthInvitations",
        },
      }
    )
    .post(
      "/api/auth/invitations/:invitationId/revoke",
      async ({ request, params }) => {
        try {
          const authOptions = resolveAuthOptions(options, request)
          const parsed = RevokeAuthInvitationParamsSchema.parse(params)
          const result = await sixb.auth.revokeInvitation(
            request,
            {
              invitationId: parsed.invitationId,
            },
            authOptions
          )

          return jsonResponse(
            {
              invitation: serializeInvitation(result.invitation),
            },
            200
          )
        } catch (error) {
          return authRouteErrorResponse(error)
        }
      },
      {
        params: RevokeAuthInvitationParamsSchema,
        response: {
          200: RevokeAuthInvitationResponseSchema,
          400: ErrorResponseSchema,
          401: ErrorResponseSchema,
          403: ErrorResponseSchema,
          404: ErrorResponseSchema,
          500: ErrorResponseSchema,
        },
        detail: {
          summary: "Revoke an auth invitation",
          tags: [OPENAPI_TAGS.authInvitations.name],
          operationId: "revokeAuthInvitation",
          security: SIXB_CSRF_SECURITY_REQUIREMENT,
        },
      }
    )
    .get(
      "/api/auth/membership-options",
      async ({ request }) => {
        try {
          const authOptions = resolveAuthOptions(options, request)
          return jsonResponse(await sixb.auth.getMembershipOptions(request, authOptions), 200)
        } catch (error) {
          return authRouteErrorResponse(error)
        }
      },
      {
        response: {
          200: GetAuthMembershipOptionsResponseSchema,
          401: ErrorResponseSchema,
          500: ErrorResponseSchema,
        },
        detail: {
          summary: "Get auth membership management options",
          tags: [OPENAPI_TAGS.authMembers.name],
          operationId: "getAuthMembershipOptions",
        },
      }
    )
    .get(
      "/api/auth/members",
      async ({ request, query }) => {
        try {
          const authOptions = resolveAuthOptions(options, request)
          const parsed = ListAuthMembersQuerySchema.parse(query)
          const result = await sixb.auth.listMembers(
            request,
            {
              limit: parseOptionalInt(parsed.limit),
              offset: parseOptionalInt(parsed.offset),
              order: parsed.order,
            },
            authOptions
          )

          return jsonResponse(
            {
              members: result.members.map(serializeMemberSummary),
              hasMore: result.hasMore,
              total: result.total,
            },
            200
          )
        } catch (error) {
          return authRouteErrorResponse(error)
        }
      },
      {
        query: ListAuthMembersQuerySchema,
        response: {
          200: ListAuthMembersResponseSchema,
          400: ErrorResponseSchema,
          401: ErrorResponseSchema,
          500: ErrorResponseSchema,
        },
        detail: {
          summary: "List auth members",
          tags: [OPENAPI_TAGS.authMembers.name],
          operationId: "listAuthMembers",
        },
      }
    )
    .patch(
      "/api/auth/members/:userId/groups",
      async ({ request, params, body }) => {
        try {
          const authOptions = resolveAuthOptions(options, request)
          const parsedParams = AuthMemberParamsSchema.parse(params)
          const parsed = UpdateAuthMemberGroupsBodySchema.parse(body)
          const result = await sixb.auth.updateMemberGroups(
            request,
            { userId: parsedParams.userId, groupIds: parsed.groupIds },
            authOptions
          )

          return jsonResponse({ member: serializeManagedMember(result.user, result.groupIds) }, 200)
        } catch (error) {
          return authRouteErrorResponse(error)
        }
      },
      {
        params: AuthMemberParamsSchema,
        body: UpdateAuthMemberGroupsBodySchema,
        response: {
          200: UpdateAuthMemberGroupsResponseSchema,
          400: ErrorResponseSchema,
          401: ErrorResponseSchema,
          403: ErrorResponseSchema,
          404: ErrorResponseSchema,
          500: ErrorResponseSchema,
        },
        detail: {
          summary: "Update an auth member's groups",
          tags: [OPENAPI_TAGS.authMembers.name],
          operationId: "updateAuthMemberGroups",
          security: SIXB_CSRF_SECURITY_REQUIREMENT,
        },
      }
    )
    .post(
      "/api/auth/members/:userId/suspend",
      async ({ request, params }) => {
        try {
          const authOptions = resolveAuthOptions(options, request)
          const parsed = AuthMemberParamsSchema.parse(params)
          const result = await sixb.auth.suspendMember(
            request,
            { userId: parsed.userId },
            authOptions
          )

          return jsonResponse({ member: serializeManagedMember(result.user, result.groupIds) }, 200)
        } catch (error) {
          return authRouteErrorResponse(error)
        }
      },
      {
        params: AuthMemberParamsSchema,
        response: {
          200: SuspendAuthMemberResponseSchema,
          401: ErrorResponseSchema,
          403: ErrorResponseSchema,
          404: ErrorResponseSchema,
          500: ErrorResponseSchema,
        },
        detail: {
          summary: "Suspend an auth member",
          tags: [OPENAPI_TAGS.authMembers.name],
          operationId: "suspendAuthMember",
          security: SIXB_CSRF_SECURITY_REQUIREMENT,
        },
      }
    )
    .post(
      "/api/auth/members/:userId/reactivate",
      async ({ request, params }) => {
        try {
          const authOptions = resolveAuthOptions(options, request)
          const parsed = AuthMemberParamsSchema.parse(params)
          const result = await sixb.auth.reactivateMember(
            request,
            { userId: parsed.userId },
            authOptions
          )

          return jsonResponse({ member: serializeManagedMember(result.user, result.groupIds) }, 200)
        } catch (error) {
          return authRouteErrorResponse(error)
        }
      },
      {
        params: AuthMemberParamsSchema,
        response: {
          200: ReactivateAuthMemberResponseSchema,
          401: ErrorResponseSchema,
          403: ErrorResponseSchema,
          404: ErrorResponseSchema,
          500: ErrorResponseSchema,
        },
        detail: {
          summary: "Reactivate an auth member",
          tags: [OPENAPI_TAGS.authMembers.name],
          operationId: "reactivateAuthMember",
          security: SIXB_CSRF_SECURITY_REQUIREMENT,
        },
      }
    )
    .post(
      "/auth/sign-in",
      async ({ body, request }) => {
        const strategy = sixb.auth.getStrategy()
        const authRedirect = resolveAuthRedirectContext(options, request, {
          audience: body.audience,
          returnTo: body.returnTo,
        })
        if (authRedirect instanceof Response) {
          return authRedirect
        }

        const authStorage = requireAuthStorage(sixb)

        if (isMagicLinkAuthStrategy(strategy)) {
          const pending = createMagicLinkPendingCredential()
          const result = await strategy.requestMagicLink({
            projectId: sixb.id,
            authStorage,
            email: body.email ?? "",
            audience: authRedirect.audience,
            returnTo: authRedirect.returnTo,
            requestOrigin: authRedirect.requestOrigin,
            requesterHash: pending.hash,
          })

          const response = htmlMessageResponse(
            "If this email can sign in, we sent a link. Check your inbox to continue.",
            200,
            "Check your email"
          )
          // Same-device fast path: this browser keeps the preimage of the
          // `requester` hash embedded in the emailed callback URL, so opening
          // the link here signs in without the confirmation click. Always
          // answer with a pending cookie of identical shape (a missing
          // Set-Cookie for ineligible emails would leak which addresses can
          // sign in), but only rotate the stored secret when a link was
          // actually delivered — a rate-limited or skipped request must not
          // orphan the hash in the previously emailed, still-valid link.
          const existingPending = getCookie(request, MAGIC_LINK_PENDING_COOKIE_NAME)?.trim()
          response.headers.append(
            "set-cookie",
            magicLinkPendingCookieHeader({
              request,
              sixb,
              value: result.status === "sent" ? pending.secret : existingPending || pending.secret,
              maxAgeSeconds: magicLinkPendingCookieMaxAgeSeconds(strategy),
            })
          )
          return response
        }

        if (isOidcAuthStrategy(strategy)) {
          const result = await strategy.startOidcSignIn({
            projectId: sixb.id,
            authStorage,
            audience: authRedirect.audience,
            returnTo: authRedirect.returnTo,
            requestOrigin: authRedirect.requestOrigin,
          })
          return redirectResponse(result.redirectTo)
        }

        return strategyNotImplementedResponse("Sign-in is not implemented yet.")
      },
      {
        body: t.Object({
          audience: t.Optional(t.String()),
          email: t.Optional(t.String()),
          returnTo: t.Optional(t.String()),
        }),
        parse: "urlencoded",
        detail: { hide: true },
      }
    )
    .get(
      "/auth/sign-in",
      async ({ request }) => {
        const strategy = sixb.auth.getStrategy()
        const url = new URL(request.url)
        const authRedirect = resolveAuthRedirectContext(options, request, {
          audience: url.searchParams.get("audience"),
          returnTo: url.searchParams.get("returnTo"),
        })
        if (authRedirect instanceof Response) {
          return authRedirect
        }

        if (isMagicLinkAuthStrategy(strategy)) {
          return signInFormResponse(authRedirect)
        }

        if (isOidcAuthStrategy(strategy)) {
          const result = await strategy.startOidcSignIn({
            projectId: sixb.id,
            authStorage: requireAuthStorage(sixb),
            audience: authRedirect.audience,
            returnTo: authRedirect.returnTo,
            requestOrigin: authRedirect.requestOrigin,
          })
          return redirectResponse(result.redirectTo)
        }

        return strategyNotImplementedResponse("Sign-in is not implemented yet.")
      },
      { detail: { hide: true } }
    )
    .get(
      "/auth/callback",
      async ({ request }) => {
        const strategy = sixb.auth.getStrategy()

        if (isMagicLinkAuthStrategy(strategy)) {
          const url = new URL(request.url)
          const magicLinkId = url.searchParams.get("magicLinkId")?.trim()
          const token = url.searchParams.get("token")?.trim()

          if (!magicLinkId || !token) {
            return htmlMessageResponse("This sign-in link is invalid or expired.", 400)
          }

          // Read-only peek so the page can greet the user by email and dead
          // links fail before the confirmation click. Email security scanners
          // (Safe Links, Avanan, Mimecast, ...) prefetch emailed URLs, so this
          // GET must not consume the single-use token — a scanner would
          // invalidate the link before the user ever opens it. The strategy
          // owns the validity rules (including token verification, so a bare
          // magicLinkId cannot disclose the account email).
          let email: string | undefined
          if (strategy.peekMagicLink) {
            try {
              const peeked = await strategy.peekMagicLink({
                projectId: sixb.id,
                authStorage: requireAuthStorage(sixb),
                magicLinkId,
                token,
              })
              if (!peeked) {
                return htmlMessageResponse("This sign-in link is invalid or expired.", 400)
              }
              email = peeked.email
            } catch {
              return htmlMessageResponse("This sign-in link is invalid or expired.", 400)
            }
          }

          // Same-device fast path: only the browser that requested this link
          // holds the preimage of the URL's `requester` hash, so it may sign in
          // straight from the navigation. Scanners and other browsers get the
          // confirmation page; POST /auth/callback completes the sign-in there.
          const requesterHash = url.searchParams.get("requester")?.trim()
          const pendingSecret = getCookie(request, MAGIC_LINK_PENDING_COOKIE_NAME)?.trim()
          if (
            requesterHash &&
            pendingSecret &&
            matchesMagicLinkRequester(pendingSecret, requesterHash)
          ) {
            return completeMagicLinkCallback({
              sixb,
              strategy,
              options,
              request,
              magicLinkId,
              token,
              clearPendingCookie: true,
            })
          }

          return magicLinkConfirmResponse({ magicLinkId, token, email })
        }

        if (isOidcAuthStrategy(strategy)) {
          const now = new Date()
          const sessionCredential = createSessionCredential()
          const device = resolveSessionDevice(request)

          try {
            const authOptions = resolveAuthOptions(options, request)
            const result = await strategy.completeOidcSignIn({
              projectId: sixb.id,
              authStorage: requireAuthStorage(sixb),
              requestUrl: request.url,
              requestOrigin: options.resolveAuthRequestOrigin(request),
              session: {
                id: sessionCredential.sessionId,
                audience: authOptions.audience,
                tokenHash: sessionCredential.tokenHash,
                createdAt: now,
                ...sixb.auth.createSessionDeadlines(now),
                ...device,
              },
            })

            return sessionCallbackCompletionResponse({
              sixb,
              request,
              apiOrigin: options.resolveAuthRequestOrigin(request),
              sessionCredential,
              audience: result.session.audience,
              expiresAt: result.session.expiresAt,
              returnTo: result.returnTo,
            })
          } catch (error) {
            logAuthCallbackError("OIDC", error)
            return htmlMessageResponse("This sign-in attempt could not be completed.", 400)
          }
        }

        return strategyNotImplementedResponse("Auth callback is not implemented yet.")
      },
      { detail: { hide: true } }
    )
    .post(
      "/auth/callback",
      async ({ body, request }) => {
        const strategy = sixb.auth.getStrategy()

        if (!isMagicLinkAuthStrategy(strategy)) {
          return strategyNotImplementedResponse("Auth callback is not implemented yet.")
        }

        const magicLinkId = body.magicLinkId?.trim()
        const token = body.token?.trim()
        if (!magicLinkId || !token) {
          return htmlMessageResponse("This sign-in link is invalid or expired.", 400)
        }

        return completeMagicLinkCallback({ sixb, strategy, options, request, magicLinkId, token })
      },
      {
        body: t.Object({
          magicLinkId: t.Optional(t.String()),
          token: t.Optional(t.String()),
        }),
        parse: "urlencoded",
        detail: { hide: true },
      }
    )
}

// The pending cookie carries the preimage of the `requester` hash embedded in
// the emailed callback URL. Only the browser that requested the link holds it,
// so GET /auth/callback can distinguish that browser (sign in immediately) from
// scanners and other devices (confirmation page). It is an anti-burn shortcut,
// not an auth credential — the magic-link token still authenticates the sign-in.
const MAGIC_LINK_PENDING_COOKIE_NAME = "sixb_pending"
// Fallback when a strategy doesn't expose its link TTL; matches the default
// magic-link TTL. An expired cookie only costs the confirmation click.
const MAGIC_LINK_PENDING_COOKIE_FALLBACK_MAX_AGE_SECONDS = 15 * 60

function magicLinkPendingCookieMaxAgeSeconds(strategy: MagicLinkAuthStrategy): number {
  return strategy.magicLinkTtlMs && strategy.magicLinkTtlMs > 0
    ? Math.max(1, Math.trunc(strategy.magicLinkTtlMs / 1000))
    : MAGIC_LINK_PENDING_COOKIE_FALLBACK_MAX_AGE_SECONDS
}

function createMagicLinkPendingCredential(): {
  readonly secret: string
  readonly hash: string
} {
  const secret = randomBytes(32).toString("base64url")
  return { secret, hash: hashMagicLinkPendingSecret(secret) }
}

function hashMagicLinkPendingSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("base64url")
}

function matchesMagicLinkRequester(pendingSecret: string, requesterHash: string): boolean {
  const expected = Buffer.from(hashMagicLinkPendingSecret(pendingSecret))
  const provided = Buffer.from(requesterHash)
  return expected.length === provided.length && timingSafeEqual(expected, provided)
}

// SameSite=Lax, not Strict: the emailed link arrives as a cross-site top-level
// navigation and the cookie must accompany that GET for the fast path to work.
function magicLinkPendingCookieHeader(params: {
  readonly request: Request
  readonly sixb: Sixb<readonly OntologySource[]>
  readonly value: string
  readonly maxAgeSeconds: number
}): string {
  const parts = [
    `${MAGIC_LINK_PENDING_COOKIE_NAME}=${params.value}`,
    "Path=/auth/callback",
    "SameSite=Lax",
    "HttpOnly",
    `Max-Age=${params.maxAgeSeconds}`,
  ]
  if (shouldUseSecureCookies(params.request, params.sixb.auth.getCookieOptions())) {
    parts.push("Secure")
  }
  return parts.join("; ")
}

// Shared by POST /auth/callback (confirmation click) and the same-device fast
// path on GET. Consumes the single-use token and mints the session cookies.
async function completeMagicLinkCallback(input: {
  readonly sixb: Sixb<readonly OntologySource[]>
  readonly strategy: MagicLinkAuthStrategy
  readonly options: AuthRoutesOptions
  readonly request: Request
  readonly magicLinkId: string
  readonly token: string
  readonly clearPendingCookie?: boolean
}): Promise<Response> {
  const authOptions = resolveAuthOptions(input.options, input.request)
  const now = new Date()
  const sessionCredential = createSessionCredential()
  const device = resolveSessionDevice(input.request)

  try {
    const result = await input.strategy.completeMagicLinkSignIn({
      projectId: input.sixb.id,
      authStorage: requireAuthStorage(input.sixb),
      magicLinkId: input.magicLinkId,
      token: input.token,
      session: {
        id: sessionCredential.sessionId,
        audience: authOptions.audience,
        tokenHash: sessionCredential.tokenHash,
        createdAt: now,
        ...input.sixb.auth.createSessionDeadlines(now),
        ...device,
      },
    })

    const response = sessionCallbackCompletionResponse({
      sixb: input.sixb,
      request: input.request,
      apiOrigin: input.options.resolveAuthRequestOrigin(input.request),
      sessionCredential,
      audience: result.session.audience,
      expiresAt: result.session.expiresAt,
      returnTo: result.returnTo,
    })
    if (input.clearPendingCookie) {
      response.headers.append(
        "set-cookie",
        magicLinkPendingCookieHeader({
          request: input.request,
          sixb: input.sixb,
          value: "",
          maxAgeSeconds: 0,
        })
      )
    }
    return response
  } catch {
    return htmlMessageResponse("This sign-in link is invalid or expired.", 400)
  }
}

// Best-effort client metadata for the active-sessions view. `x-forwarded-for`
// only reflects the real client behind a trusted proxy; both values are display
// only and never used for authorization.
function resolveSessionDevice(request: Request): {
  readonly userAgent?: string
  readonly ipAddress?: string
} {
  return {
    userAgent: request.headers.get("user-agent")?.trim() || undefined,
    ipAddress:
      request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
      request.headers.get("x-real-ip")?.trim() ||
      undefined,
  }
}

function sessionCallbackCompletionResponse(input: {
  readonly sixb: Sixb<readonly OntologySource[]>
  readonly request: Request
  readonly apiOrigin: string
  readonly sessionCredential: ReturnType<typeof createSessionCredential>
  readonly audience: AuthSessionAudience
  readonly expiresAt: Date
  readonly returnTo: string
}): Response {
  const cookieOptions = input.sixb.auth.getCookieOptions({ audience: input.audience })
  const headers = new Headers({
    "cache-control": "no-store",
  })
  headers.append(
    "set-cookie",
    createSessionCookieHeader({
      request: input.request,
      value: input.sessionCredential.cookieValue,
      expiresAt: input.expiresAt,
      options: cookieOptions,
    })
  )
  headers.append(
    "set-cookie",
    createCsrfCookieHeader({
      request: input.request,
      value: generateCsrfToken(),
      expiresAt: input.expiresAt,
      options: cookieOptions,
    })
  )

  return authCallbackCompletionResponse(input.returnTo, headers, input.apiOrigin)
}

// OAuth and magic-link callbacks can arrive as a cross-site navigation, and a direct
// 3xx after setting SameSite=Strict cookies keeps the chained request cross-site — the
// cookies get dropped. That only matters when the return target is on the API origin
// itself (e.g. /docs); there, finish on a Sixb document first and navigate from it.
// Any other origin doesn't need our cookies on the navigation, so redirect straight
// through — the page the user is on (email client or the confirmation page with its
// loading button) stays visible until the app renders.
function authCallbackCompletionResponse(
  returnTo: string,
  headers: Headers,
  apiOrigin: string
): Response {
  if (!isSameOriginReturnTarget(returnTo, apiOrigin)) {
    headers.set("location", returnTo)
    return new Response(null, { status: 303, headers })
  }

  return authCallbackCompletionDocumentResponse(returnTo, headers)
}

function isSameOriginReturnTarget(returnTo: string, apiOrigin: string): boolean {
  try {
    return new URL(returnTo).origin === apiOrigin
  } catch {
    return true
  }
}

// `style-src 'unsafe-inline'` lets the shared auth-page stylesheet apply; the page
// stays script-free and everything else is locked down by `default-src 'none'`.
function authCallbackCompletionDocumentResponse(returnTo: string, headers: Headers): Response {
  headers.set("content-type", "text/html; charset=utf-8")
  headers.set(
    "content-security-policy",
    `default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; navigate-to ${resolveNavigateToSources(
      returnTo
    )}`
  )
  headers.set("referrer-policy", "no-referrer")
  headers.set("x-content-type-options", "nosniff")

  return new Response(
    authPageDocument(
      [
        "<h1>Signing you in&hellip;</h1>",
        `<p>If you are not redirected automatically, <a href="${escapeHtml(returnTo)}">continue</a>.</p>`,
      ].join(""),
      "Signing in",
      [
        '<meta name="referrer" content="no-referrer">',
        `<meta http-equiv="refresh" content="0;url=${escapeHtml(returnTo)}">`,
      ].join("")
    ),
    {
      status: 200,
      headers,
    }
  )
}

function resolveAuthOptions(
  options: AuthRoutesOptions,
  request: Request
): ReturnType<ResolveRequestAuthContext> {
  return options.resolveAuthContext(request)
}

function resolveAuthRedirectContext(
  options: AuthRoutesOptions,
  request: Request,
  input: Parameters<ResolveAuthRedirectContext>[1]
): AuthRedirectContext | Response {
  try {
    return options.resolveAuthRedirectContext(request, input)
  } catch (error) {
    if (error instanceof BrowserOriginError) {
      return htmlMessageResponse("This sign-in request is invalid.", 400)
    }

    throw error
  }
}

function resolveInvitationDeliveryContext(
  options: AuthRoutesOptions,
  request: Request,
  input: AuthInvitationRedirectInput
): AuthInvitationRedirectContext | Response {
  try {
    return options.resolveInvitationRedirectContext(request, input)
  } catch (error) {
    if (error instanceof BrowserOriginError) {
      return jsonErrorResponse("runtime.invalid_input", "Invitation destination is not allowed")
    }

    throw error
  }
}

function resolveSessionCsrfToken(input: {
  readonly request: Request
  readonly cookieOptions: ResolvedCookieOptions
  readonly expiresAt: Date
}): { readonly token: string; readonly setCookie?: string } {
  const existing = getCookie(input.request, input.cookieOptions.csrfCookieName)
  if (existing) {
    return { token: existing }
  }

  const token = generateCsrfToken()
  return {
    token,
    setCookie: createCsrfCookieHeader({
      request: input.request,
      value: token,
      expiresAt: input.expiresAt,
      options: input.cookieOptions,
    }),
  }
}

function authSessionJsonResponse(
  body: AuthenticatedAuthSessionResponse,
  setCookies: readonly string[]
): Response {
  const headers = new Headers({
    "content-type": "application/json; charset=utf-8",
    [CSRF_TOKEN_RESPONSE_HEADER_NAME]: body.csrfToken,
  })
  for (const setCookie of setCookies) headers.append("set-cookie", setCookie)
  return jsonResponse(body, 200, headers)
}

function redirectResponse(location: string): Response {
  return new Response(null, {
    status: 303,
    headers: {
      location,
      "cache-control": "no-store",
    },
  })
}

function strategyNotImplementedResponse(message: string): Response {
  return new Response(message, {
    status: 501,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
    },
  })
}

// Mirrors the Atlas design tokens (packages/ui/src/styles/globals.css) so the
// server-rendered auth pages feel familiar. Self-contained: no external CSS, and dark mode
// follows the system preference since these standalone pages have no client theme runtime.
const AUTH_PAGE_STYLE = `<style>
:root {
  color-scheme: light dark;
  --background: #fafafa;
  --foreground: #101010;
  --card: #ffffff;
  --primary: #0a0a0a;
  --primary-foreground: #ffffff;
  --border: #e2e2e2;
  --muted-foreground: #5f5f5f;
  --ring: #0a0a0a;
  --radius: 0.5rem;
}
@media (prefers-color-scheme: dark) {
  :root {
    --background: #0a0a0a;
    --foreground: #f4f4f4;
    --card: #141414;
    --primary: #f4f4f4;
    --primary-foreground: #0a0a0a;
    --border: #262626;
    --muted-foreground: #8a8a8a;
    --ring: #f4f4f4;
  }
}
* { box-sizing: border-box; }
html, body { height: 100%; }
body {
  margin: 0;
  font-family: "SF Pro Text", "SF Pro Display", "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif;
  background: var(--background);
  color: var(--foreground);
  line-height: 1.5;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
}
.shell {
  min-height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 1.5rem;
}
.card {
  width: 100%;
  max-width: 20rem;
  /* Nudge above dead-center so the form sits a touch higher on the page. */
  transform: translateY(-6vh);
}
h1 {
  margin: 0 0 0.5rem;
  font-size: 1.25rem;
  font-weight: 600;
  letter-spacing: -0.01em;
}
p {
  margin: 0;
  color: var(--muted-foreground);
  font-size: 0.875rem;
}
p strong {
  color: var(--foreground);
  font-weight: 500;
}
a {
  color: var(--foreground);
  text-underline-offset: 0.2em;
}
form { margin: 1.75rem 0 0; }
input[type="email"] {
  width: 100%;
  height: 2.5rem;
  padding: 0 0.875rem;
  font: inherit;
  font-size: 0.9375rem;
  color: var(--foreground);
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: calc(var(--radius) - 2px);
}
input[type="email"]::placeholder { color: var(--muted-foreground); }
input[type="email"]:focus {
  outline: none;
  border-color: var(--ring);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--ring) 18%, transparent);
}
button {
  width: 100%;
  height: 2.5rem;
  margin-top: 0.75rem;
  font: inherit;
  font-size: 0.875rem;
  font-weight: 500;
  color: var(--primary-foreground);
  background: var(--primary);
  border: none;
  border-radius: calc(var(--radius) - 2px);
  cursor: pointer;
}
button:hover:not(:disabled) { opacity: 0.9; }
button:focus-visible {
  outline: 2px solid var(--ring);
  outline-offset: 2px;
}
button:disabled { cursor: default; }
.spinner {
  display: inline-block;
  width: 1rem;
  height: 1rem;
  vertical-align: -0.2em;
  border: 2px solid color-mix(in srgb, var(--primary-foreground) 35%, transparent);
  border-top-color: var(--primary-foreground);
  border-radius: 50%;
  animation: spin 0.6s linear infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }
</style>`

function authPageDocument(body: string, title = "Sign in", head = ""): string {
  return [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeHtml(title)}</title>`,
    head,
    AUTH_PAGE_STYLE,
    "</head>",
    "<body>",
    '<main class="shell">',
    '<section class="card">',
    body,
    "</section>",
    "</main>",
    "</body>",
    "</html>",
  ].join("")
}

function authPageResponse(body: string, status = 200): Response {
  return new Response(authPageDocument(body), {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    },
  })
}

function signInFormResponse(context: AuthRedirectContext): Response {
  return authPageResponse(
    [
      "<h1>Sign in</h1>",
      "<p>We'll email you a sign-in link.</p>",
      '<form method="post" action="/auth/sign-in">',
      `<input type="hidden" name="audience" value="${escapeHtml(context.audience)}">`,
      `<input type="hidden" name="returnTo" value="${escapeHtml(context.returnTo)}">`,
      '<input name="email" type="email" autocomplete="email" placeholder="you@example.com" aria-label="Email address" required autofocus>',
      '<button type="submit">Send sign-in link</button>',
      "</form>",
    ].join("")
  )
}

// Deliberately a plain form with no auto-submit: link scanners that execute
// pages headlessly still won't press the button, so the token survives until a
// person clicks Continue. The extra click also keeps the link reusable when a
// phone opens it in a preview or hands it to a different default browser. The
// inline script never submits anything — it only turns the clicked button into
// a disabled spinner. The form POST is a normal navigation, so this page stays
// visible (spinner and all) until the server responds; the pageshow handler
// resets the button when the page is restored from the back/forward cache.
function magicLinkConfirmResponse(input: {
  readonly magicLinkId: string
  readonly token: string
  // Absent when the strategy doesn't support the read-only peek.
  readonly email?: string
}): Response {
  const response = authPageResponse(
    [
      "<h1>Sign in</h1>",
      input.email
        ? `<p>You're signing in as <strong>${escapeHtml(input.email)}</strong>.</p>`
        : "<p>Click continue to finish signing in.</p>",
      '<form method="post" action="/auth/callback" id="confirm">',
      `<input type="hidden" name="magicLinkId" value="${escapeHtml(input.magicLinkId)}">`,
      `<input type="hidden" name="token" value="${escapeHtml(input.token)}">`,
      '<button type="submit" id="confirm-button">Continue</button>',
      "</form>",
      "<script>",
      '(function () {var button = document.getElementById("confirm-button");',
      'document.getElementById("confirm").addEventListener("submit", function () {',
      "button.disabled = true;",
      'button.setAttribute("aria-busy", "true");',
      'button.innerHTML = \'<span class="spinner" aria-hidden="true"></span>\';',
      "});",
      'window.addEventListener("pageshow", function (event) {',
      "if (!event.persisted) return;",
      "button.disabled = false;",
      'button.removeAttribute("aria-busy");',
      'button.textContent = "Continue";',
      "});})();",
      "</script>",
    ].join("")
  )
  // The single-use token is in this page's URL; keep it out of cross-origin
  // referrers. Must stay `same-origin`, not `no-referrer` — a no-referrer policy
  // makes browsers send `Origin: null` on the form POST, which the browser-origin
  // guard rejects before the callback route runs.
  response.headers.set("referrer-policy", "same-origin")
  return response
}

function resolveNavigateToSources(returnTo: string): string {
  try {
    return `'self' ${new URL(returnTo).origin}`
  } catch {
    return "'self'"
  }
}

function htmlMessageResponse(message: string, status = 200, heading?: string): Response {
  return authPageResponse(
    [heading ? `<h1>${escapeHtml(heading)}</h1>` : "", `<p>${escapeHtml(message)}</p>`].join(""),
    status
  )
}

function requireAuthStorage(sixb: Sixb<readonly OntologySource[]>): AuthStorage {
  if (!sixb.storage.auth) {
    throw new Error("[SixbServer] Auth storage is required for auth routes.")
  }

  return sixb.storage.auth
}

function serializeGroupOption(group: GroupDefinition) {
  return {
    id: group.id,
    ...(group.label !== undefined ? { label: group.label } : {}),
    ...(group.description !== undefined ? { description: group.description } : {}),
  }
}

function serializeAccessToken(
  accessToken: AccessTokenRecord,
  options: { readonly subjectLabel?: string } = {}
) {
  const now = Date.now()
  const status = accessToken.revokedAt
    ? "revoked"
    : accessToken.expiresAt.getTime() <= now
      ? "expired"
      : "active"

  return {
    id: accessToken.id,
    name: accessToken.name,
    kind: accessToken.kind,
    status,
    subjectType: accessToken.subjectType,
    subjectId: accessToken.subjectId,
    subjectLabel: options.subjectLabel,
    groupIds: accessToken.groupIds ? [...accessToken.groupIds] : undefined,
    createdAt: toIsoString(accessToken.createdAt),
    expiresAt: toIsoString(accessToken.expiresAt),
    revokedAt: accessToken.revokedAt ? toIsoString(accessToken.revokedAt) : undefined,
    lastUsedAt: accessToken.lastUsedAt ? toIsoString(accessToken.lastUsedAt) : undefined,
    lastUsedUserAgent: accessToken.lastUsedUserAgent,
    lastUsedIpAddress: accessToken.lastUsedIpAddress,
  }
}

function serializeServiceAccount(
  serviceAccount: ServiceAccountRecord,
  groupIds: readonly string[]
) {
  return {
    id: serviceAccount.id,
    name: serviceAccount.name,
    description: serviceAccount.description,
    status: serviceAccount.status,
    groupIds: [...groupIds],
    createdAt: toIsoString(serviceAccount.createdAt),
    updatedAt: toIsoString(serviceAccount.updatedAt),
  }
}

function parseRequiredFutureDate(value: string): Date {
  const date = parseDate(value)
  if (!date) {
    throw new SixbValidationError("runtime.invalid_input", "Expiration is required.")
  }

  if (date.getTime() <= Date.now()) {
    throw new SixbValidationError("runtime.invalid_input", "Expiration must be in the future.")
  }

  return date
}

function optionalTrimmed(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed ? trimmed : undefined
}

// Token and service-account management can be driven by a personal access
// token (for CLI credential rotation) as well as a browser session, so reject
// unauthenticated requests with 401 and non-user principals (service-account
// tokens) with 403. Service-account tokens are runtime credentials and must not
// mint or manage further credentials.
function requireAuthenticatedUserSession(
  session: AuthRequestResult
): AuthenticatedUserRequestSession | Response {
  if (!session.authenticated) {
    return jsonErrorResponse("auth.authentication_required", "Authentication required")
  }

  if (!isAuthenticatedUserSession(session)) {
    return jsonErrorResponse("auth.permission_denied", "User authentication is required")
  }

  return session
}

function isAuthenticatedUserSession(
  session: AuthRequestResult & { readonly authenticated: true }
): session is AuthenticatedUserRequestSession {
  return session.principal.type === "user"
}

function serializeInvitation(invitation: InvitationRecord) {
  return {
    id: invitation.id,
    email: invitation.email,
    groupIds: [...invitation.groupIds],
    status: invitation.status,
    createdAt: toIsoString(invitation.createdAt),
    updatedAt: toIsoString(invitation.updatedAt),
    expiresAt: toIsoString(invitation.expiresAt),
    acceptedAt: invitation.acceptedAt ? toIsoString(invitation.acceptedAt) : undefined,
    revokedAt: invitation.revokedAt ? toIsoString(invitation.revokedAt) : undefined,
  }
}

function serializeMemberSummary(member: MemberSummary) {
  return {
    ...serializeManagedMember(member.user, member.groupIds),
    capabilities: member.capabilities,
  }
}

function serializeManagedMember(user: UserRecord, groupIds: readonly string[]) {
  return {
    user: serializeMemberUser(user),
    groupIds: [...groupIds],
  }
}

function serializeMemberUser(user: UserRecord) {
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    avatarUrl: user.avatarUrl,
    status: user.status,
    createdAt: toIsoString(user.createdAt),
    updatedAt: toIsoString(user.updatedAt),
  }
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
}

/**
 * Two `reason` ladders and a read of the message text used to decide the status here. Every auth
 * error carries a code now, and the code answers all three: a rejected magic link is the same 401
 * as a rejected password, a duplicate invitation is a 409, and a suspended account is a 403 —
 * distinctions the ladder collapsed into 400.
 */
function authRouteErrorResponse(error: unknown): Response {
  const failure = toSixbFailure(error, { fallbackCode: "runtime.unexpected" })
  return jsonErrorResponse(failure.code, failure.message)
}

function logAuthCallbackError(kind: string, error: unknown): void {
  if (process.env.NODE_ENV !== "development" && process.env.SIXB_AUTH_DEBUG !== "1") {
    return
  }

  const detail =
    error instanceof AuthStorageError
      ? `${error.name}(${error.reason}): ${error.message}`
      : error instanceof Error
        ? `${error.name}: ${error.message}`
        : String(error)

  console.error(`[SixbServer] ${kind} auth callback failed: ${detail}`)
}

function jsonResponse(body: unknown, status: number, headersInit?: HeadersInit): Response {
  const headers = new Headers(headersInit)
  headers.set("content-type", headers.get("content-type") ?? "application/json; charset=utf-8")
  headers.set("cache-control", headers.get("cache-control") ?? "no-store")

  return new Response(JSON.stringify(body), {
    status,
    headers,
  })
}
