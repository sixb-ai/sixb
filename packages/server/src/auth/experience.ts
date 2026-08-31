import { resolve } from "node:path"
import type { AuthSessionAudience } from "@sixb/core"

const AUTH_BOOTSTRAP_PLACEHOLDER = "__SIXB_AUTH_BOOTSTRAP__"
const AUTH_ASSET_PREFIX = "/auth/assets/"

export interface SixbAuthExperienceOptions {
  readonly outdir: string
  readonly audience?: AuthSessionAudience
}

export type AuthExperiencePageState =
  | { readonly kind: "signIn" }
  | { readonly kind: "checkEmail" }
  | { readonly kind: "confirm"; readonly email?: string }
  | { readonly kind: "invalidLink" }
  | { readonly kind: "error" }

export interface AuthExperienceSubmission {
  readonly kind: "requestMagicLink" | "confirmSignIn"
  readonly action: string
  readonly fields: Readonly<Record<string, string>>
}

export async function customAuthExperienceResponse(
  options: SixbAuthExperienceOptions | undefined,
  input: {
    readonly audience: AuthSessionAudience
    readonly state: AuthExperiencePageState
    readonly signInUrl: string
    readonly submission?: AuthExperienceSubmission
    readonly status?: number
    readonly referrerPolicy?: "no-referrer" | "same-origin"
    readonly formActionOrigins?: readonly string[]
  }
): Promise<Response | null> {
  if (!options || input.audience !== (options.audience ?? "app")) {
    return null
  }

  const template = Bun.file(resolve(options.outdir, "index.html"))
  if (!(await template.exists())) {
    return null
  }

  const html = await template.text()
  if (!html.includes(AUTH_BOOTSTRAP_PLACEHOLDER)) {
    console.warn(
      `[SixbServer] Custom auth experience in ${options.outdir} is missing its bootstrap placeholder. Using the generic page.`
    )
    return null
  }

  const bootstrap = Buffer.from(
    JSON.stringify({
      state: input.state,
      signInUrl: input.signInUrl,
      ...(input.submission ? { submission: input.submission } : {}),
    })
  ).toString("base64url")
  const formAction = ["'self'", ...(input.formActionOrigins ?? []).map(normalizeCspOrigin)].join(
    " "
  )

  return new Response(html.replace(AUTH_BOOTSTRAP_PLACEHOLDER, bootstrap), {
    status: input.status ?? 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy": [
        "default-src 'none'",
        "script-src 'self'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data:",
        "font-src 'self'",
        "base-uri 'none'",
        `form-action ${formAction}`,
        "frame-ancestors 'none'",
      ].join("; "),
      "referrer-policy": input.referrerPolicy ?? "no-referrer",
      "x-content-type-options": "nosniff",
    },
  })
}

function normalizeCspOrigin(value: string): string {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error(`[SixbServer] Invalid custom auth form-action origin: '${value}'.`)
  }

  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.origin !== value) {
    throw new Error(`[SixbServer] Invalid custom auth form-action origin: '${value}'.`)
  }
  return url.origin
}

export async function customAuthExperienceAssetResponse(
  options: SixbAuthExperienceOptions | undefined,
  request: Request
): Promise<Response> {
  const method = request.method.toUpperCase()
  if (!options || (method !== "GET" && method !== "HEAD")) {
    return notFoundResponse()
  }

  const url = new URL(request.url)
  if (!url.pathname.startsWith(AUTH_ASSET_PREFIX)) {
    return notFoundResponse()
  }

  let fileName: string
  try {
    fileName = decodeURIComponent(url.pathname.slice(AUTH_ASSET_PREFIX.length))
  } catch {
    return notFoundResponse()
  }
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(fileName)) {
    return notFoundResponse()
  }

  const path = resolve(options.outdir, "assets", fileName)
  const source = Bun.file(path)
  if (!(await source.exists())) {
    return notFoundResponse()
  }

  const encoding = await resolvePrecompressedAsset(request, path)
  const body = encoding ? Bun.file(`${path}.${encoding === "br" ? "br" : "gz"}`) : source
  const headers = new Headers({
    "content-type": source.type || "application/octet-stream",
    "cache-control": "public, max-age=31536000, immutable",
    "x-content-type-options": "nosniff",
  })
  if (encoding) {
    headers.set("content-encoding", encoding)
    headers.set("vary", "Accept-Encoding")
  }
  return new Response(method === "HEAD" ? null : body, { headers })
}

async function resolvePrecompressedAsset(
  request: Request,
  sourcePath: string
): Promise<"br" | "gzip" | null> {
  for (const encoding of acceptedPrecompressedEncodings(request)) {
    const suffix = encoding === "br" ? "br" : "gz"
    if (await Bun.file(`${sourcePath}.${suffix}`).exists()) {
      return encoding
    }
  }
  return null
}

function acceptedPrecompressedEncodings(request: Request): ("br" | "gzip")[] {
  const header = request.headers.get("accept-encoding")
  if (!header) return []

  const qualities = new Map<string, number>()
  for (const item of header.split(",")) {
    const [rawName, ...parameters] = item.trim().split(";")
    const name = rawName.toLowerCase()
    let quality = 1
    for (const parameter of parameters) {
      const match = parameter.trim().match(/^q=(0(?:\.\d+)?|1(?:\.0+)?)$/)
      if (match) quality = Number(match[1])
    }
    qualities.set(name, quality)
  }

  const wildcard = qualities.get("*") ?? 0
  return (["br", "gzip"] as const)
    .map((encoding, preference) => ({
      encoding,
      preference,
      quality: qualities.get(encoding) ?? wildcard,
    }))
    .filter((candidate) => candidate.quality > 0)
    .sort((left, right) => right.quality - left.quality || left.preference - right.preference)
    .map((candidate) => candidate.encoding)
}

function notFoundResponse(): Response {
  return new Response("Not Found", {
    status: 404,
    headers: { "content-type": "text/plain; charset=utf-8" },
  })
}
