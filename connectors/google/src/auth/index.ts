import { GoogleAuthError } from "../errors"
import {
  type ApplicationDefaultClientLoader,
  createApplicationDefaultTokenSource,
} from "./application-default"
import {
  createServiceAccountTokenSource,
  type ServiceAccountTokenSourceDeps,
} from "./service-account"
import type { GoogleAuthOptions, TokenSource } from "./types"

export type { GoogleAuthOptions, ServiceAccountKey, TokenSource } from "./types"

/** Test seams for credential discovery, time, and token exchange. */
interface TokenSourceDeps extends ServiceAccountTokenSourceDeps {
  readonly loadApplicationDefaultClient?: ApplicationDefaultClientLoader
}

export function createTokenSource(
  auth: GoogleAuthOptions,
  deps: TokenSourceDeps = {}
): TokenSource {
  if ("token" in auth) {
    return createResolverTokenSource(auth.token)
  }

  if ("applicationDefault" in auth) {
    if (auth.applicationDefault !== true) {
      throw new GoogleAuthError("applicationDefault must be true when ADC auth is selected.")
    }
    validateScopes(auth.scopes, "application-default")
    return createApplicationDefaultTokenSource(auth.scopes, deps.loadApplicationDefaultClient)
  }

  validateScopes(auth.scopes, "service-account")
  return createServiceAccountTokenSource(auth.serviceAccountKey, auth.scopes, auth.subject, deps)
}

function createResolverTokenSource(resolve: () => string | Promise<string>): TokenSource {
  const get = (): Promise<string> => Promise.resolve(resolve())
  return {
    get,
    async getRequestHeaders() {
      return new Headers({ Authorization: `Bearer ${await get()}` })
    },
    invalidate() {},
  }
}

function validateScopes(scopes: readonly string[], mode: string): void {
  if (scopes.length === 0 || scopes.some((scope) => !scope.trim())) {
    throw new GoogleAuthError(`at least one non-empty scope is required for ${mode} auth.`)
  }
}
