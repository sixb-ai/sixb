import { chmod } from "node:fs/promises"
import {
  generateApiKey,
  generateCodeChallenge,
  generateCodeVerifier,
  generateState,
  getAppTimestamp,
  getTimestampMsForApiKey,
} from "./crypto"
import type { AuthTokens } from "./types"
import { API_CONSTANTS } from "./types"

/** Internal context for OAuth2 authentication flow */
interface AuthFlowContext {
  codeVerifier: string
  state: string
  cookies: string[]
}

/**
 * Panasonic OAuth2 PKCE authentication handler.
 *
 * Handles the complete Auth0-based OAuth2 flow including:
 * - Initial authentication with email/password
 * - Token refresh
 * - Token persistence
 */
export class PanasonicAuth {
  private tokens: AuthTokens | null = null

  /**
   * Authenticate with email and password using OAuth2 PKCE flow.
   *
   * This follows the Panasonic Comfort Cloud mobile app authentication flow:
   * 1. Generate PKCE code verifier and challenge
   * 2. GET /authorize with redirect following to get login page
   * 3. POST credentials to /usernamepassword/login
   * 4. POST to /login/callback to get authorization code
   * 5. Follow /authorize/resume redirect
   * 6. Exchange code for tokens at /oauth/token
   */
  async authenticate(email: string, password: string): Promise<AuthTokens> {
    // Initialize PKCE parameters
    const codeVerifier = generateCodeVerifier()
    const codeChallenge = await generateCodeChallenge(codeVerifier)
    const state = generateState()
    const cookies: string[] = []
    const ctx: AuthFlowContext = { codeVerifier, state, cookies }

    // Step 1-2: Start authorization flow and get CSRF token
    const { csrfToken, formState } = await this.startAuthorizationFlow(codeChallenge, ctx)

    // Step 3: Submit login credentials
    const { wctx, wresult } = await this.submitCredentials(
      email,
      password,
      csrfToken,
      formState,
      ctx
    )

    // Step 4: Complete callback and get authorization code
    const authCode = await this.completeCallback(wctx, wresult, ctx)

    // Step 5: Exchange code for OAuth tokens
    const tokenData = await this.exchangeCodeForTokens(authCode, ctx.codeVerifier)

    // Step 6: Get ACC client ID from Comfort Cloud API
    const clientId = await this.getAccClientId(tokenData.access_token)

    this.tokens = {
      accessToken: tokenData.access_token,
      refreshToken: tokenData.refresh_token,
      expiresAt: Date.now() + tokenData.expires_in * 1000,
      clientId,
    }

    return this.tokens
  }

  /**
   * Start the OAuth2 authorization flow and extract CSRF token.
   */
  private async startAuthorizationFlow(
    codeChallenge: string,
    ctx: AuthFlowContext
  ): Promise<{ csrfToken: string; formState: string }> {
    const authorizeUrl = new URL("/authorize", API_CONSTANTS.AUTH0_DOMAIN)
    authorizeUrl.searchParams.set("scope", API_CONSTANTS.SCOPE)
    authorizeUrl.searchParams.set("audience", API_CONSTANTS.AUDIENCE)
    authorizeUrl.searchParams.set("protocol", "oauth2")
    authorizeUrl.searchParams.set("response_type", "code")
    authorizeUrl.searchParams.set("code_challenge", codeChallenge)
    authorizeUrl.searchParams.set("code_challenge_method", "S256")
    authorizeUrl.searchParams.set("auth0Client", this.getAuth0Client())
    authorizeUrl.searchParams.set("client_id", API_CONSTANTS.CLIENT_ID)
    authorizeUrl.searchParams.set("redirect_uri", API_CONSTANTS.REDIRECT_URI)
    authorizeUrl.searchParams.set("state", ctx.state)

    // Follow redirects and collect cookies
    let currentUrl = authorizeUrl.toString()
    let authorizeResponse: Response | undefined
    let redirectCount = 0
    const maxRedirects = 10

    while (redirectCount < maxRedirects) {
      authorizeResponse = await fetch(currentUrl, {
        method: "GET",
        headers: {
          "User-Agent": "okhttp/4.10.0",
          ...(ctx.cookies.length > 0 ? { Cookie: ctx.cookies.join("; ") } : {}),
        },
        redirect: "manual",
      })

      this.collectCookies(authorizeResponse, ctx.cookies)

      if (authorizeResponse.status >= 300 && authorizeResponse.status < 400) {
        const location = authorizeResponse.headers.get("location")
        if (location) {
          currentUrl = this.resolveUrl(currentUrl, location)
          redirectCount++
          continue
        }
      }
      break
    }

    if (!authorizeResponse) {
      throw new Error("Failed to complete authorization flow: no response received")
    }

    const authorizeHtml = await authorizeResponse.text()

    // Extract CSRF token and state from response
    let csrfToken = this.extractCsrfFromCookie(ctx.cookies)
    let configState: string | null = null

    const configMatch = authorizeHtml.match(/name="config"\s+value="([^"]+)"/)
    if (configMatch) {
      try {
        const configJson = JSON.parse(atob(configMatch[1]))
        if (configJson.extraParams?._csrf) {
          csrfToken = configJson.extraParams._csrf
        }
        if (configJson.extraParams?.state) {
          configState = configJson.extraParams.state
        }
      } catch {
        // Ignore parse errors
      }
    }

    if (!csrfToken) {
      throw new Error("Failed to extract CSRF token from authorize response")
    }

    const extractField = (name: string): string | null => {
      const regex = new RegExp(`name="${name}"[^>]+value="([^"]*)"`)
      const match = authorizeHtml.match(regex)
      return match?.[1] ?? null
    }
    const formState = configState ?? extractField("state") ?? ctx.state

    return { csrfToken, formState }
  }

  /**
   * Submit login credentials and extract callback parameters.
   */
  private async submitCredentials(
    email: string,
    password: string,
    csrfToken: string,
    formState: string,
    ctx: AuthFlowContext
  ): Promise<{ wctx: string; wresult: string }> {
    const loginUrl = new URL("/usernamepassword/login", API_CONSTANTS.AUTH0_DOMAIN)
    const loginBody = new URLSearchParams({
      client_id: API_CONSTANTS.CLIENT_ID,
      redirect_uri: API_CONSTANTS.REDIRECT_URI,
      tenant: "pdpauthglb-a1",
      response_type: "code",
      scope: API_CONSTANTS.SCOPE,
      audience: API_CONSTANTS.AUDIENCE,
      _csrf: csrfToken,
      state: formState,
      _intstate: "deprecated",
      username: email,
      password: password,
      connection: "PanasonicID-Authentication",
    })

    const loginResponse = await fetch(loginUrl.toString(), {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": "okhttp/4.10.0",
        Auth0_Client: this.getAuth0Client(),
        Cookie: ctx.cookies.join("; "),
      },
      body: loginBody.toString(),
    })

    if (!loginResponse.ok) {
      const errorText = await loginResponse.text()
      if (errorText.includes("Wrong email or password")) {
        throw new Error("Invalid email or password")
      }
      throw new Error(`Login failed: ${loginResponse.status} ${loginResponse.statusText}`)
    }

    const loginHtml = await loginResponse.text()

    const wctxMatch = loginHtml.match(/name="wctx"[^>]+value="([^"]*)"/)
    const wresultMatch = loginHtml.match(/name="wresult"[^>]+value="([^"]*)"/)

    if (!wctxMatch || !wresultMatch) {
      throw new Error("Failed to extract callback parameters from login response")
    }

    return {
      wctx: this.decodeHtmlEntities(wctxMatch[1]),
      wresult: this.decodeHtmlEntities(wresultMatch[1]),
    }
  }

  /**
   * Complete the login callback and extract authorization code.
   */
  private async completeCallback(
    wctx: string,
    wresult: string,
    ctx: AuthFlowContext
  ): Promise<string> {
    const callbackUrl = new URL("/login/callback", API_CONSTANTS.AUTH0_DOMAIN)
    const callbackBody = new URLSearchParams({ wctx, wresult })

    const callbackResponse = await fetch(callbackUrl.toString(), {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": "okhttp/4.10.0",
        Cookie: ctx.cookies.join("; "),
      },
      body: callbackBody.toString(),
      redirect: "manual",
    })

    let redirectUrl = callbackResponse.headers.get("location")
    if (!redirectUrl) {
      throw new Error("No redirect URL in callback response")
    }

    if (redirectUrl.startsWith("/")) {
      redirectUrl = `${API_CONSTANTS.AUTH0_DOMAIN}${redirectUrl}`
    }

    // Follow /authorize/resume if needed
    if (redirectUrl.includes("/authorize/resume")) {
      const resumeResponse = await fetch(redirectUrl, {
        method: "GET",
        headers: {
          "User-Agent": "okhttp/4.10.0",
          Cookie: ctx.cookies.join("; "),
        },
        redirect: "manual",
      })

      const resumeRedirect = resumeResponse.headers.get("location")
      if (!resumeRedirect) {
        throw new Error("No redirect from /authorize/resume")
      }
      redirectUrl = resumeRedirect
    }

    // Extract authorization code
    const redirectParsed = new URL(redirectUrl)
    const authCode = redirectParsed.searchParams.get("code")
    if (!authCode) {
      const error = redirectParsed.searchParams.get("error")
      const errorDesc = redirectParsed.searchParams.get("error_description")
      if (error) {
        throw new Error(`Authorization failed: ${error} - ${errorDesc}`)
      }
      throw new Error("No authorization code in redirect URL")
    }

    return authCode
  }

  /**
   * Exchange authorization code for OAuth tokens.
   */
  private async exchangeCodeForTokens(
    authCode: string,
    codeVerifier: string
  ): Promise<{ access_token: string; refresh_token: string; expires_in: number }> {
    const tokenUrl = new URL("/oauth/token", API_CONSTANTS.AUTH0_DOMAIN)
    const tokenBody = new URLSearchParams({
      scope: API_CONSTANTS.SCOPE,
      client_id: API_CONSTANTS.CLIENT_ID,
      grant_type: "authorization_code",
      code: authCode,
      redirect_uri: API_CONSTANTS.REDIRECT_URI,
      code_verifier: codeVerifier,
    })

    const tokenResponse = await fetch(tokenUrl.toString(), {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": "okhttp/4.10.0",
        Auth0_Client: this.getAuth0Client(),
      },
      body: tokenBody.toString(),
    })

    if (!tokenResponse.ok) {
      throw new Error(`Token exchange failed: ${tokenResponse.status} ${tokenResponse.statusText}`)
    }

    return tokenResponse.json()
  }

  /**
   * Get ACC client ID by authenticating with the Comfort Cloud API.
   */
  private async getAccClientId(accessToken: string): Promise<string> {
    const accLoginUrl = `${API_CONSTANTS.API_BASE}/auth/v2/login`

    const now = new Date()
    const appTimestamp = getAppTimestamp(now)
    const timestampMs = getTimestampMsForApiKey(now)
    const apiKey = await generateApiKey(accessToken, timestampMs)

    const accLoginResponse = await fetch(accLoginUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json;charset=utf-8",
        "User-Agent": "G-RAC",
        "x-app-type": "1",
        "x-app-version": API_CONSTANTS.APP_VERSION,
        "x-app-name": "Comfort Cloud",
        "x-app-timestamp": appTimestamp,
        "x-cfc-api-key": apiKey,
        "x-user-authorization-v2": `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ language: 0 }),
    })

    if (!accLoginResponse.ok) {
      const errorText = await accLoginResponse.text().catch(() => "")
      throw new Error(
        `ACC login failed: ${accLoginResponse.status} ${accLoginResponse.statusText}. ${errorText}`
      )
    }

    const accLoginData = await accLoginResponse.json()
    return accLoginData.clientId
  }

  /**
   * Get a valid access token, refreshing if expired.
   */
  async getAccessToken(): Promise<string> {
    if (!this.tokens) {
      throw new Error("Not authenticated. Call authenticate() or loadTokens() first.")
    }

    // Refresh if token expires in less than 5 minutes
    if (Date.now() >= this.tokens.expiresAt - 5 * 60 * 1000) {
      await this.refreshTokens()
    }

    return this.tokens.accessToken
  }

  /**
   * Refresh the access token using the refresh token.
   */
  async refreshTokens(): Promise<AuthTokens> {
    if (!this.tokens?.refreshToken) {
      throw new Error("No refresh token available")
    }

    const tokenUrl = new URL("/oauth/token", API_CONSTANTS.AUTH0_DOMAIN)
    const tokenBody = new URLSearchParams({
      scope: API_CONSTANTS.SCOPE,
      client_id: API_CONSTANTS.CLIENT_ID,
      refresh_token: this.tokens.refreshToken,
      grant_type: "refresh_token",
    })

    const response = await fetch(tokenUrl.toString(), {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": "okhttp/4.10.0",
        Auth0_Client: this.getAuth0Client(),
      },
      body: tokenBody.toString(),
    })

    if (!response.ok) {
      throw new Error(`Token refresh failed: ${response.status} ${response.statusText}`)
    }

    const tokenData = await response.json()

    this.tokens = {
      accessToken: tokenData.access_token,
      refreshToken: tokenData.refresh_token ?? this.tokens.refreshToken,
      expiresAt: Date.now() + tokenData.expires_in * 1000,
    }

    return this.tokens
  }

  /**
   * Refresh tokens with automatic retry and exponential backoff.
   * @param maxRetries Maximum number of retry attempts (default: 3)
   */
  async refreshTokensWithRetry(maxRetries = 3): Promise<AuthTokens> {
    let lastError: Error | null = null

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        return await this.refreshTokens()
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error))
        if (attempt < maxRetries - 1) {
          const delay = Math.min(1000 * 2 ** attempt, 30000)
          console.warn(
            `[Panasonic] Token refresh failed (attempt ${attempt + 1}/${maxRetries}), retrying in ${delay}ms`
          )
          await new Promise((resolve) => setTimeout(resolve, delay))
        }
      }
    }

    throw new Error(`Token refresh failed after ${maxRetries} attempts: ${lastError?.message}`)
  }

  /**
   * Load tokens from a JSON file.
   */
  async loadTokens(path: string): Promise<AuthTokens> {
    const file = Bun.file(path)
    const exists = await file.exists()
    if (!exists) {
      throw new Error(`Token file not found: ${path}. Run 'sixb panasonic:login' first.`)
    }

    const data = await file.json()
    if (!data.accessToken || !data.refreshToken || !data.expiresAt) {
      throw new Error(`Invalid token file: ${path}`)
    }

    this.tokens = data as AuthTokens
    return this.tokens
  }

  /**
   * Save tokens to a JSON file with secure permissions (chmod 600).
   */
  async saveTokens(path: string): Promise<void> {
    if (!this.tokens) {
      throw new Error("No tokens to save")
    }

    await Bun.write(path, JSON.stringify(this.tokens, null, 2))
    await chmod(path, 0o600)
  }

  /**
   * Check if currently authenticated (has tokens).
   */
  isAuthenticated(): boolean {
    return this.tokens !== null
  }

  /**
   * Get the current tokens (for inspection/debugging).
   */
  getTokens(): AuthTokens | null {
    return this.tokens
  }

  /**
   * Get the ACC client ID for API requests.
   */
  async getClientId(): Promise<string> {
    if (!this.tokens?.clientId) {
      throw new Error("No client ID available. Re-authenticate to obtain one.")
    }
    return this.tokens.clientId
  }

  /**
   * Get token expiration timestamp (Unix ms).
   */
  getExpiresAt(): number {
    return this.tokens?.expiresAt ?? 0
  }

  /**
   * Generate the Auth0-Client header value.
   */
  private getAuth0Client(): string {
    const clientInfo = {
      name: "Auth0.Android",
      version: "2.9.3",
      env: {
        android: "33",
      },
    }
    return btoa(JSON.stringify(clientInfo))
  }

  /**
   * Collect cookies from response headers.
   */
  private collectCookies(response: Response, cookies: string[]): void {
    const setCookies = response.headers.getSetCookie?.() ?? []
    for (const cookie of setCookies) {
      const cookieName = cookie.split("=")[0]
      const cookieValue = cookie.split(";")[0]
      const existingIndex = cookies.findIndex((c) => c.startsWith(`${cookieName}=`))
      if (existingIndex >= 0) {
        cookies[existingIndex] = cookieValue
      } else {
        cookies.push(cookieValue)
      }
    }
  }

  /**
   * Extract CSRF token from cookies.
   */
  private extractCsrfFromCookie(cookies: string[]): string | null {
    const csrfCookie = cookies.find((c) => c.startsWith("_csrf="))
    return csrfCookie ? csrfCookie.split("=")[1] : null
  }

  /**
   * Resolve a potentially relative URL.
   */
  private resolveUrl(baseUrl: string, location: string): string {
    if (location.startsWith("/")) {
      const base = new URL(baseUrl)
      return `${base.origin}${location}`
    }
    if (location.startsWith("http")) {
      return location
    }
    return location
  }

  /**
   * Decode HTML entities in a string.
   */
  private decodeHtmlEntities(str: string): string {
    return str
      .replace(/&#34;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&quot;/g, '"')
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
  }
}
