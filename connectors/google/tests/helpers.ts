import type { ConnectorContext } from "@sixb/core"
import type { ServiceAccountKey } from "../src/auth"

export const CONTEXT: ConnectorContext = {
  projectId: "demo",
  connectorId: "google",
  signal: new AbortController().signal,
}

const originalFetch = globalThis.fetch

export function mockFetch(
  implementation: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
): void {
  globalThis.fetch = implementation as unknown as typeof fetch
}

export function restoreFetch(): void {
  globalThis.fetch = originalFetch
}

export function json(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  })
}

export async function collect<T>(items: AsyncIterable<T>): Promise<T[]> {
  const collected: T[] = []
  for await (const item of items) {
    collected.push(item)
  }
  return collected
}

/** A real RSA keypair as a service-account key, for exercising the JWT signing path. */
export async function generateServiceAccountKey(): Promise<{
  key: ServiceAccountKey
  publicKey: CryptoKey
}> {
  const pair = (await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"]
  )) as CryptoKeyPair
  const pkcs8 = await crypto.subtle.exportKey("pkcs8", pair.privateKey)
  return {
    key: {
      client_email: "svc@example.iam.gserviceaccount.com",
      private_key: toPem(pkcs8, "PRIVATE KEY"),
      token_uri: "https://oauth2.test/token",
    },
    publicKey: pair.publicKey,
  }
}

/** Verify a compact JWS (`header.payload.signature`) against a public key. */
export async function verifyJwt(jwt: string, publicKey: CryptoKey): Promise<boolean> {
  const [header, payload, signature] = jwt.split(".")
  return crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    publicKey,
    base64urlToBytes(signature),
    new TextEncoder().encode(`${header}.${payload}`)
  )
}

export function decodeJwtClaims(jwt: string): Record<string, unknown> {
  const [, payload] = jwt.split(".")
  return JSON.parse(new TextDecoder().decode(base64urlToBytes(payload)))
}

function toPem(der: ArrayBuffer, label: string): string {
  const bytes = new Uint8Array(der)
  let binary = ""
  for (const byte of bytes) {
    binary += String.fromCharCode(byte)
  }
  const base64 = btoa(binary)
  const lines = base64.match(/.{1,64}/g) ?? []
  return `-----BEGIN ${label}-----\n${lines.join("\n")}\n-----END ${label}-----\n`
}

function base64urlToBytes(value: string): Uint8Array<ArrayBuffer> {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/")
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=")
  const binary = atob(padded)
  const bytes = new Uint8Array(new ArrayBuffer(binary.length))
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}
