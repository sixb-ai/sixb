import { createHash, randomBytes } from "node:crypto"

export interface MagicLinkCredential {
  readonly token: string
  readonly tokenHash: string
}

export function createMagicLinkCredential(): MagicLinkCredential {
  const token = randomBytes(32).toString("base64url")
  return {
    token,
    tokenHash: hashMagicLinkToken(token),
  }
}

export function hashMagicLinkToken(token: string): string {
  return createHash("sha256").update(token).digest("hex")
}
