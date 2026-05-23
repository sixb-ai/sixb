import { createHash, randomBytes } from "node:crypto"

export function createOpaqueSecret(): string {
  return randomBytes(32).toString("base64url")
}

export function formatOidcState(input: {
  readonly attemptId: string
  readonly nonce: string
  readonly secret: string
}): string {
  return `${input.attemptId}.${input.secret}.${input.nonce}`
}

export function parseOidcState(value: string | null): {
  readonly attemptId: string
  readonly nonce: string
  readonly secret: string
  readonly state: string
} | null {
  const state = value?.trim()
  if (!state) {
    return null
  }

  const parts = state.split(".")
  if (parts.length !== 3) {
    return null
  }

  const [attemptId, secret, nonce] = parts
  if (!attemptId.startsWith("oidc_")) {
    return null
  }

  if (!secret || !nonce) {
    return null
  }

  return { attemptId, nonce, secret, state }
}

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex")
}
