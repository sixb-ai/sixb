import {
  type AccessTokenRecord,
  type AuthenticatedUserRequestSession,
  type AuthRequestResult,
  AuthRuntimeError,
  type AuthSessionAudience,
  type AuthStorage,
  AuthStorageError,
  clearCsrfCookieHeader,
  clearSessionCookieHeader,
  createCsrfCookieHeader,
  createSessionCookieHeader,
  createSessionCredential,
  type GroupDefinition,
  generateCsrfToken,
  getCookie,
  type InvitationRecord,
  isMagicLinkAuthStrategy,
  isOidcAuthStrategy,
  type OntologySource,
  type ServiceAccountRecord,
  type Sixb,
  verifyDoubleSubmitCsrf,
} from "@sixb/core"
import { type Elysia, t } from "elysia"
import { bearerSecurityRequirement } from "../auth/access-token-boundary"
import {
  type AuthRedirectContext,
  BrowserOriginError,
  type ResolveAuthRedirectContext,
  type ResolveRequestAuthContext,
} from "../auth/browser-origin"
import { SIXB_CSRF_SECURITY_REQUIREMENT } from "../openapi/security"
import {
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
  ListAuthAccessTokensResponseSchema,
  ListAuthInvitationsQuerySchema,
  ListAuthInvitationsResponseSchema,
  ListAuthServiceAccountAccessTokensResponseSchema,
  ListAuthServiceAccountsResponseSchema,
  ListAuthSessionsResponseSchema,
  RevokeAuthAccessTokenParamsSchema,
  RevokeAuthAccessTokenResponseSchema,
  RevokeAuthInvitationParamsSchema,
  RevokeAuthInvitationResponseSchema,
  RevokeAuthServiceAccountAccessTokenParamsSchema,
  RevokeAuthServiceAccountAccessTokenResponseSchema,
  RevokeAuthSessionParamsSchema,
  RevokeAuthSessionResponseSchema,
  SignOutAllResponseSchema,
} from "../schemas/auth"
import { ErrorResponseSchema } from "../schemas/common"
import { parseDate, parseOptionalInt, toIsoString } from "../utils/http"

type ResolvedCookieOptions = Parameters<typeof createCsrfCookieHeader>[0]["options"]
type AuthenticatedAuthSessionResponse = {
  readonly authenticated: true
  readonly csrfToken: string
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
  readonly resolveAuthRequestOrigin: (request: Request) => string
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
        const session = await sixb.auth.getSession(request, authOptions)
        if (!session.authenticated) {
          return jsonResponse({ authenticated: false as const }, 200)
        }

        const cookieOptions = sixb.auth.getCookieOptions(authOptions)
        const csrf = resolveSessionCsrfToken({ sixb, request, cookieOptions })
        return authSessionJsonResponse(
          {
            authenticated: true as const,
            csrfToken: csrf.token,
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
          csrf.setCookie
        )
      },
      {
        response: { 200: AuthSessionResponseSchema },
        detail: {
          summary: "Get current auth session",
          tags: ["Auth"],
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
          return jsonResponse({ error: "CSRF verification failed" }, 403)
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
          tags: ["Auth"],
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
          return jsonResponse({ error: "Authentication required" }, 401)
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
          tags: ["Auth"],
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
          return jsonResponse({ error: "Authentication required" }, 401)
        }
        if (!verifyDoubleSubmitCsrf(request, { cookieName: cookieOptions.csrfCookieName })) {
          return jsonResponse({ error: "CSRF verification failed" }, 403)
        }

        const { sessionId } = RevokeAuthSessionParamsSchema.parse(params)
        const storage = requireAuthStorage(sixb)
        const target = await storage.sessions.getById({ projectId: sixb.id, id: sessionId })
        // Only the caller's own sessions are revocable. A missing or foreign
        // session id returns the same 404 so it cannot probe other accounts.
        if (!target || target.userId !== session.user.id) {
          return jsonResponse({ error: "Session not found" }, 404)
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
          tags: ["Auth"],
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
          return jsonResponse({ error: "Authentication required" }, 401)
        }
        if (!verifyDoubleSubmitCsrf(request, { cookieName: cookieOptions.csrfCookieName })) {
          return jsonResponse({ error: "CSRF verification failed" }, 403)
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
          tags: ["Auth"],
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
                .getGroupDefinitions()
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
          tags: ["Auth"],
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
          tags: ["Auth"],
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
          tags: ["Auth"],
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
          tags: ["Auth"],
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
          tags: ["Auth"],
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
          tags: ["Auth"],
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
          tags: ["Auth"],
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
          tags: ["Auth"],
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
          tags: ["Auth"],
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
          tags: ["Auth"],
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
          const deliveryContext = resolveInvitationDeliveryContext(
            options,
            request,
            parsed.returnTo,
            authOptions
          )
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
          tags: ["Auth"],
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
          return jsonResponse(await sixb.auth.getInvitationOptions(request, authOptions), 200)
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
          tags: ["Auth"],
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
          tags: ["Auth"],
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
          tags: ["Auth"],
          operationId: "revokeAuthInvitation",
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
          await strategy.requestMagicLink({
            projectId: sixb.id,
            authStorage,
            email: body.email ?? "",
            audience: authRedirect.audience,
            returnTo: authRedirect.returnTo,
            requestOrigin: authRedirect.requestOrigin,
          })

          return htmlMessageResponse(
            "If this email can sign in, we sent a link. Check your inbox to continue.",
            200,
            "Check your email"
          )
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
        const now = new Date()
        const sessionCredential = createSessionCredential()
        const device = resolveSessionDevice(request)

        if (isMagicLinkAuthStrategy(strategy)) {
          const authOptions = resolveAuthOptions(options, request)
          const url = new URL(request.url)
          const magicLinkId = url.searchParams.get("magicLinkId")?.trim()
          const token = url.searchParams.get("token")?.trim()

          if (!magicLinkId || !token) {
            return htmlMessageResponse("This sign-in link is invalid or expired.", 400)
          }

          try {
            const result = await strategy.completeMagicLinkSignIn({
              projectId: sixb.id,
              authStorage: requireAuthStorage(sixb),
              magicLinkId,
              token,
              session: {
                id: sessionCredential.sessionId,
                audience: authOptions.audience,
                tokenHash: sessionCredential.tokenHash,
                createdAt: now,
                expiresAt: new Date(now.getTime() + sixb.auth.getSessionTtlMs()),
                ...device,
              },
            })

            return sessionCallbackCompletionResponse({
              sixb,
              request,
              sessionCredential,
              audience: result.session.audience,
              returnTo: result.returnTo,
            })
          } catch {
            return htmlMessageResponse("This sign-in link is invalid or expired.", 400)
          }
        }

        if (isOidcAuthStrategy(strategy)) {
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
                expiresAt: new Date(now.getTime() + sixb.auth.getSessionTtlMs()),
                ...device,
              },
            })

            return sessionCallbackCompletionResponse({
              sixb,
              request,
              sessionCredential,
              audience: result.session.audience,
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
  readonly sessionCredential: ReturnType<typeof createSessionCredential>
  readonly audience: AuthSessionAudience
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
      maxAgeSeconds: Math.trunc(input.sixb.auth.getSessionTtlMs() / 1000),
      options: cookieOptions,
    })
  )
  headers.append(
    "set-cookie",
    createCsrfCookieHeader({
      request: input.request,
      value: generateCsrfToken(),
      maxAgeSeconds: Math.trunc(input.sixb.auth.getSessionTtlMs() / 1000),
      options: cookieOptions,
    })
  )

  return authCallbackCompletionResponse(input.returnTo, headers)
}

// OAuth and magic-link callbacks arrive from a cross-site navigation. A direct 3xx after
// setting SameSite=Strict cookies can keep the next request in that cross-site redirect
// chain. Finish on a Sixb document first, then navigate to the sanitized return path.
function authCallbackCompletionResponse(returnTo: string, headers: Headers): Response {
  headers.set("content-type", "text/html; charset=utf-8")
  headers.set(
    "content-security-policy",
    `default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; navigate-to ${resolveNavigateToSources(
      returnTo
    )}`
  )
  headers.set("referrer-policy", "no-referrer")
  headers.set("x-content-type-options", "nosniff")

  return new Response(
    [
      "<!doctype html>",
      '<html lang="en">',
      "<head>",
      '<meta charset="utf-8">',
      '<meta name="viewport" content="width=device-width, initial-scale=1">',
      '<meta name="referrer" content="no-referrer">',
      `<meta http-equiv="refresh" content="0;url=${escapeHtml(returnTo)}">`,
      "<title>Signing in</title>",
      "</head>",
      "<body>",
      "<main>",
      "<p>Signing you in...</p>",
      `<p><a href="${escapeHtml(returnTo)}">Continue</a></p>`,
      "</main>",
      "</body>",
      "</html>",
    ].join(""),
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
  returnTo: string | undefined,
  authContext: ReturnType<ResolveRequestAuthContext>
): AuthRedirectContext | Response {
  try {
    return options.resolveAuthRedirectContext(request, {
      audience: authContext.audience,
      fallbackReturnToOrigin: authContext.browserOrigin,
      returnTo,
    })
  } catch (error) {
    if (error instanceof BrowserOriginError) {
      return jsonResponse({ error: "Invitation return target is not allowed" }, 400)
    }

    throw error
  }
}

function resolveSessionCsrfToken(input: {
  readonly sixb: Sixb<readonly OntologySource[]>
  readonly request: Request
  readonly cookieOptions: ResolvedCookieOptions
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
      maxAgeSeconds: Math.trunc(input.sixb.auth.getSessionTtlMs() / 1000),
      options: input.cookieOptions,
    }),
  }
}

function authSessionJsonResponse(
  body: AuthenticatedAuthSessionResponse,
  csrfSetCookie: string | undefined
): Response {
  if (!csrfSetCookie) {
    return jsonResponse(body, 200)
  }

  const headers = new Headers({ "content-type": "application/json; charset=utf-8" })
  headers.append("set-cookie", csrfSetCookie)
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
button:hover { opacity: 0.9; }
button:focus-visible {
  outline: 2px solid var(--ring);
  outline-offset: 2px;
}
</style>`

function authPageDocument(body: string, title = "Sign in"): string {
  return [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeHtml(title)}</title>`,
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
    throw new Error("Expiration is required.")
  }

  if (date.getTime() <= Date.now()) {
    throw new Error("Expiration must be in the future.")
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
    return jsonResponse({ error: "Authentication required" }, 401)
  }

  if (!isAuthenticatedUserSession(session)) {
    return jsonResponse({ error: "User authentication is required" }, 403)
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

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
}

function authRouteErrorResponse(error: unknown): Response {
  if (error instanceof AuthRuntimeError) {
    if (error.code === "authentication_required") {
      return jsonResponse({ error: error.message }, 401)
    }

    if (error.code === "authorization_denied") {
      return jsonResponse({ error: error.message }, 403)
    }

    if (error.code === "invalid_auth_input") {
      return jsonResponse({ error: error.message }, 400)
    }

    if (error.code === "rate_limited") {
      return jsonResponse({ error: error.message }, 429)
    }

    return jsonResponse({ error: error.message }, 500)
  }

  if (error instanceof AuthStorageError) {
    if (
      error.code === "missing_invitation" ||
      error.code === "missing_access_token" ||
      error.code === "missing_service_account"
    ) {
      return jsonResponse({ error: error.message }, 404)
    }

    return jsonResponse({ error: error.message }, 400)
  }

  if (error instanceof Error) {
    const status =
      error.message.startsWith("Invalid date:") ||
      error.message.startsWith("Invalid integer:") ||
      error.message.startsWith("Expiration ")
        ? 400
        : 500
    return jsonResponse({ error: error.message }, status)
  }

  return jsonResponse({ error: String(error) }, 500)
}

function logAuthCallbackError(kind: string, error: unknown): void {
  if (process.env.NODE_ENV !== "development" && process.env.SIXB_AUTH_DEBUG !== "1") {
    return
  }

  const detail =
    error instanceof AuthStorageError
      ? `${error.name}(${error.code}): ${error.message}`
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
