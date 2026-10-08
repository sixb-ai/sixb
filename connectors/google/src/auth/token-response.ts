/** Parse an OAuth endpoint body: JSON when it is JSON, the raw text otherwise. */
export async function readJsonSafe(response: Response): Promise<unknown> {
  const text = await response.text()
  if (!text) {
    return undefined
  }
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

/** Render an OAuth error body (`{ error, error_description }`) as `error: description`. */
export function formatOAuthError(payload: Record<string, unknown>): string | null {
  const error = payload.error
  if (typeof error !== "string") {
    return null
  }
  const description = payload.error_description
  return typeof description === "string" ? `${error}: ${description}` : error
}
