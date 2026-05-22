import * as openid from "openid-client"

export interface OidcTokenResponse {
  readonly access_token?: string
  claims(): Readonly<Record<string, unknown>> | undefined
}

export interface OidcClientAdapter {
  randomPKCECodeVerifier(): string
  calculatePKCECodeChallenge(codeVerifier: string): Promise<string>
  discovery(issuer: URL, clientId: string, clientSecret: string): Promise<unknown>
  buildAuthorizationUrl(config: unknown, parameters: Record<string, string>): URL
  authorizationCodeGrant(
    config: unknown,
    currentUrl: URL,
    checks: {
      readonly pkceCodeVerifier: string
      readonly expectedState: string
      readonly expectedNonce: string
      readonly idTokenExpected: true
    }
  ): Promise<OidcTokenResponse>
  fetchUserInfo(
    config: unknown,
    accessToken: string,
    expectedSubject: string
  ): Promise<Readonly<Record<string, unknown>>>
}

export const defaultOidcClientAdapter: OidcClientAdapter = {
  randomPKCECodeVerifier: openid.randomPKCECodeVerifier,
  calculatePKCECodeChallenge: openid.calculatePKCECodeChallenge,
  async discovery(issuer, clientId, clientSecret) {
    return openid.discovery(issuer, clientId, clientSecret)
  },
  buildAuthorizationUrl(config, parameters) {
    return openid.buildAuthorizationUrl(config as openid.Configuration, parameters)
  },
  async authorizationCodeGrant(config, currentUrl, checks) {
    return openid.authorizationCodeGrant(config as openid.Configuration, currentUrl, checks)
  },
  async fetchUserInfo(config, accessToken, expectedSubject) {
    return openid.fetchUserInfo(config as openid.Configuration, accessToken, expectedSubject)
  },
}
