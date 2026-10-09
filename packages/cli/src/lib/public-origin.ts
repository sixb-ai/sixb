/**
 * One definition of a public origin, for every role that reads one.
 *
 * `SIXB_API_PUBLIC_ORIGIN` used to mean something different depending on who read it: the browser
 * roles parsed it and refused anything that was not a bare origin, while the agent worker took any
 * non-blank string and discovered the problem at its first request instead. The same value could
 * therefore stop `sixb api` at startup and start `sixb worker agent`, which is the failure mode
 * worth removing — a bad origin should be refused once, by the first role that reads it.
 */

/** An origin is scheme, host, and port, and nothing after them. */
export function normalizeOrigin(value: string, label: string): string {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error(`[SixbCLI] Invalid ${label}: '${value}'.`)
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`[SixbCLI] ${label} must use http or https.`)
  }

  if (url.pathname !== "/" || url.search || url.hash) {
    throw new Error(`[SixbCLI] ${label} must be an origin, not a full URL.`)
  }

  return url.origin
}

/**
 * The origin a flag or the environment set, normalized. `null` when neither did, and a thrown
 * error when one of them set something that is not an origin.
 */
export function configuredOrigin(
  value: string | undefined,
  envName: string,
  label: string
): string | null {
  const configured = nonblank(value) ?? nonblank(process.env[envName])
  return configured === undefined ? null : normalizeOrigin(configured, label)
}

function nonblank(value: string | undefined): string | undefined {
  return value?.trim() || undefined
}
