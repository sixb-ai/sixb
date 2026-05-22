/**
 * PKCE and crypto utilities for Panasonic OAuth2 authentication.
 */

/** Characters allowed in base64url encoding (RFC 4648) */
const BASE64URL_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"

/**
 * Generate a cryptographically random code verifier for PKCE.
 * @returns A random string of 43-128 characters using base64url charset
 */
export function generateCodeVerifier(length = 64): string {
  const array = new Uint8Array(length)
  crypto.getRandomValues(array)

  let result = ""
  for (let i = 0; i < length; i++) {
    result += BASE64URL_CHARS[array[i] % BASE64URL_CHARS.length]
  }
  return result
}

/**
 * Generate a code challenge from a code verifier using SHA-256.
 * @param verifier The code verifier string
 * @returns Base64url-encoded SHA-256 hash of the verifier
 */
export async function generateCodeChallenge(verifier: string): Promise<string> {
  const encoder = new TextEncoder()
  const data = encoder.encode(verifier)
  const digest = await crypto.subtle.digest("SHA-256", data)

  return base64UrlEncode(new Uint8Array(digest))
}

/**
 * Encode a Uint8Array as a base64url string (no padding).
 */
export function base64UrlEncode(buffer: Uint8Array): string {
  let binary = ""
  for (let i = 0; i < buffer.length; i++) {
    binary += String.fromCharCode(buffer[i])
  }
  const base64 = btoa(binary)
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

/**
 * Generate timestamp in format required by Panasonic API: "YYYY-MM-DD HH:mm:ss"
 */
export function getAppTimestamp(date: Date = new Date()): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, "0")
  const day = String(date.getDate()).padStart(2, "0")
  const hours = String(date.getHours()).padStart(2, "0")
  const minutes = String(date.getMinutes()).padStart(2, "0")
  const seconds = String(date.getSeconds()).padStart(2, "0")

  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`
}

/**
 * Generate a random state parameter for OAuth2.
 */
export function generateState(): string {
  return generateCodeVerifier(32)
}

/**
 * Secret used for generating the API key signature.
 * This is a publicly known value reverse-engineered from the Panasonic Comfort Cloud mobile app.
 * It's not a private secret - it's embedded in the app binary and required for API compatibility.
 * Source: https://github.com/sockless-coding/panasonic_cc (Python SDK)
 */
const API_KEY_SECRET = "521325fb2dd486bf4831b47644317fca"

/**
 * Get timestamp in milliseconds for API key generation.
 *
 * IMPORTANT: The API key expects the local time values to be treated as UTC.
 * For example, if local time is "2026-02-04 10:30:00" (Paris, UTC+1),
 * we need milliseconds for "2026-02-04 10:30:00 UTC" (not the actual UTC equivalent).
 * This matches how the Python SDK generates the API key.
 */
export function getTimestampMsForApiKey(date: Date = new Date()): number {
  return Date.UTC(
    date.getFullYear(),
    date.getMonth(),
    date.getDate(),
    date.getHours(),
    date.getMinutes(),
    date.getSeconds(),
    0
  )
}

/**
 * Generate the x-cfc-api-key signature for Panasonic API requests.
 * Format: SHA256("Comfort Cloud" + secret + timestamp_ms + "Bearer " + token) with "cfc" inserted at position 9
 */
export async function generateApiKey(accessToken: string, timestampMs: number): Promise<string> {
  const data = `Comfort Cloud${API_KEY_SECRET}${timestampMs}Bearer ${accessToken}`
  const encoder = new TextEncoder()
  const hashBuffer = await crypto.subtle.digest("SHA-256", encoder.encode(data))
  const hashArray = Array.from(new Uint8Array(hashBuffer))
  const hashHex = hashArray.map((b) => b.toString(16).padStart(2, "0")).join("")

  // Insert "cfc" at position 9
  return `${hashHex.slice(0, 9)}cfc${hashHex.slice(9)}`
}
