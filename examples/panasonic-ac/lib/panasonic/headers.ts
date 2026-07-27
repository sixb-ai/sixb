import type { PanasonicAuth } from "./auth"
import { generateApiKey, getAppTimestamp, getTimestampMsForApiKey } from "./crypto"
import { API_CONSTANTS } from "./types"

/**
 * Build the full set of Panasonic Comfort Cloud API headers.
 *
 * Called on every request by the REST connector's header resolver.
 * Each call produces fresh timestamp-dependent values (x-app-timestamp, x-cfc-api-key).
 */
export async function buildPanasonicHeaders(
  auth: PanasonicAuth,
  appVersion: string = API_CONSTANTS.APP_VERSION
): Promise<HeadersInit> {
  const accessToken = await auth.getAccessToken()
  const clientId = await auth.getClientId()
  const now = new Date()
  const appTimestamp = getAppTimestamp(now)
  const timestampMs = getTimestampMsForApiKey(now)
  const apiKey = await generateApiKey(accessToken, timestampMs)

  return {
    Accept: "application/json;charset=utf-8",
    "Content-Type": "application/json;charset=utf-8",
    "User-Agent": "G-RAC",
    "x-app-type": "1",
    "x-app-version": appVersion,
    "x-app-name": "Comfort Cloud",
    "x-app-timestamp": appTimestamp,
    "x-cfc-api-key": apiKey,
    "x-client-id": clientId,
    "x-user-authorization-v2": `Bearer ${accessToken}`,
  }
}
