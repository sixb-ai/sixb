import { createHash } from "node:crypto"
import type { DeployAccessKey } from "@sixb/core/deploy"

const KEY_TYPES = new Set([
  "ssh-ed25519",
  "ssh-rsa",
  "ecdsa-sha2-nistp256",
  "ecdsa-sha2-nistp384",
  "ecdsa-sha2-nistp521",
  "sk-ssh-ed25519@openssh.com",
  "sk-ecdsa-sha2-nistp256@openssh.com",
])

export interface AuthorizedKey extends DeployAccessKey {
  /** The line as it appears in `authorized_keys`. */
  readonly line: string
}

/**
 * One `authorized_keys` line: optional options, then type, key, and comment. Returns `null` for
 * blank lines, comments, and anything that is not a public key.
 */
export function parseAuthorizedKey(line: string): AuthorizedKey | null {
  const trimmed = line.trim()
  if (!trimmed || trimmed.startsWith("#")) return null
  const words = trimmed.split(/\s+/)
  const typeIndex = words.findIndex((word) => KEY_TYPES.has(word))
  if (typeIndex === -1) return null
  const type = words[typeIndex] ?? ""
  const encoded = words[typeIndex + 1] ?? ""

  const blob = Buffer.from(encoded, "base64")
  // The blob names its own type first; a key pasted under another type is not that key.
  const nameLength = blob.length >= 4 ? blob.readUInt32BE(0) : 0
  if (blob.subarray(4, 4 + nameLength).toString() !== type) return null

  const options = typeIndex > 0 ? words.slice(0, typeIndex).join(" ") : ""
  return {
    type,
    fingerprint: `SHA256:${createHash("sha256").update(blob).digest("base64").replace(/=+$/, "")}`,
    comment: words.slice(typeIndex + 2).join(" "),
    restricted: /(^|,)restrict(,|$)/.test(options),
    line: trimmed,
  }
}

/** Parses a public key given as text, failing with what is wrong with it. */
export function parsePublicKey(text: string): AuthorizedKey {
  const key = parseAuthorizedKey(text)
  if (!key || key.line.includes("\n")) {
    throw new Error(
      "[SshTarget] That is not an SSH public key. Pass the contents of a .pub file, such as " +
        "`ssh-ed25519 AAAA… you@laptop`."
    )
  }
  return key
}
