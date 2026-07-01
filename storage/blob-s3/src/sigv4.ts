import type { Buffer } from "node:buffer"
import { createHash, createHmac } from "node:crypto"

// Hand-rolled AWS Signature Version 4 query-string ("presigned URL") signer for
// S3 and S3-compatible backends. Bun's S3Client.presign cannot sign the custom
// checksum/copy-source headers this provider relies on, so we sign here. Kept in
// its own module with known-answer unit tests because signing correctness is
// security-sensitive and easy to break silently.

export function encodeRfc3986(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`
  )
}

export function encodeS3Path(value: string): string {
  return value.split("/").map(encodeRfc3986).join("/")
}

function normalizeHeaderValue(value: string): string {
  return value.trim().replace(/\s+/g, " ")
}

function canonicalSignedHeaders(headers: Readonly<Record<string, string>>): {
  readonly canonicalHeaders: string
  readonly signedHeaders: string
} {
  const entries = Object.entries(headers)
    .map(([name, value]) => [name.toLowerCase(), normalizeHeaderValue(value)] as const)
    .sort(([left], [right]) => left.localeCompare(right))

  return {
    canonicalHeaders: entries.map(([name, value]) => `${name}:${value}\n`).join(""),
    signedHeaders: entries.map(([name]) => name).join(";"),
  }
}

function canonicalQueryString(params: Record<string, string>): string {
  return Object.entries(params)
    .map(([key, value]) => [encodeRfc3986(key), encodeRfc3986(value)] as const)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join("&")
}

function formatAmzDate(date: Date): string {
  return date.toISOString().replace(/[:-]|\.\d{3}/g, "")
}

function hmac(key: Buffer | string, value: string): Buffer {
  return createHmac("sha256", key).update(value).digest()
}

function signingKey(input: {
  readonly secretAccessKey: string
  readonly dateStamp: string
  readonly region: string
}): Buffer {
  const dateKey = hmac(`AWS4${input.secretAccessKey}`, input.dateStamp)
  const regionKey = hmac(dateKey, input.region)
  const serviceKey = hmac(regionKey, "s3")
  return hmac(serviceKey, "aws4_request")
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex")
}

export interface S3ObjectUrlConfig {
  readonly key: string
  readonly bucket: string
  readonly region: string
  readonly endpoint?: string
  readonly pathStyle: boolean
}

export function s3ObjectUrl(config: S3ObjectUrlConfig): URL {
  const encodedKey = encodeS3Path(config.key)
  if (!config.endpoint) {
    return new URL(`https://${config.bucket}.s3.${config.region}.amazonaws.com/${encodedKey}`)
  }

  const base = new URL(config.endpoint.endsWith("/") ? config.endpoint : `${config.endpoint}/`)
  if (config.pathStyle) {
    return new URL(`${encodeRfc3986(config.bucket)}/${encodedKey}`, base)
  }

  base.hostname = `${config.bucket}.${base.hostname}`
  base.pathname = `/${encodedKey}`
  base.search = ""
  return base
}

export interface S3PresignConfig extends S3ObjectUrlConfig {
  readonly method: string
  readonly headers: Readonly<Record<string, string>>
  readonly expiresInSeconds: number
  readonly accessKeyId: string
  readonly secretAccessKey: string
  readonly sessionToken?: string
  /** Signing timestamp; injected explicitly so callers/tests stay deterministic. */
  readonly now: Date
}

export function presignS3Url(config: S3PresignConfig): string {
  const url = s3ObjectUrl(config)
  const amzDate = formatAmzDate(config.now)
  const dateStamp = amzDate.slice(0, 8)
  const scope = `${dateStamp}/${config.region}/s3/aws4_request`
  const { canonicalHeaders, signedHeaders } = canonicalSignedHeaders({
    ...config.headers,
    host: url.host,
  })
  const query: Record<string, string> = {
    "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
    "X-Amz-Credential": `${config.accessKeyId}/${scope}`,
    "X-Amz-Date": amzDate,
    "X-Amz-Expires": config.expiresInSeconds.toString(),
    "X-Amz-SignedHeaders": signedHeaders,
    ...(config.sessionToken === undefined ? {} : { "X-Amz-Security-Token": config.sessionToken }),
  }
  const canonicalRequest = [
    config.method,
    url.pathname,
    canonicalQueryString(query),
    canonicalHeaders,
    signedHeaders,
    "UNSIGNED-PAYLOAD",
  ].join("\n")
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256Hex(canonicalRequest)].join("\n")
  const signature = createHmac(
    "sha256",
    signingKey({
      secretAccessKey: config.secretAccessKey,
      dateStamp,
      region: config.region,
    })
  )
    .update(stringToSign)
    .digest("hex")

  url.search = canonicalQueryString({ ...query, "X-Amz-Signature": signature })
  return url.toString()
}
