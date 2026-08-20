import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto"
import { ConnectorError } from "./errors"

export type ConnectorCredentialPurpose = "oauth-authorization" | "pkce-verifier"

/** Immutable identity authenticated alongside one sealed connector credential. */
export interface ConnectorCredentialContext {
  readonly projectId: string
  readonly connectorId: string
  readonly recordId: string
  readonly purpose: ConnectorCredentialPurpose
}

/** Versioned AEAD envelope safe to persist. */
export interface SealedConnectorCredential {
  readonly version: 1
  readonly algorithm: "A256GCM"
  readonly keyId: string
  readonly nonce: string
  readonly ciphertext: string
  readonly tag: string
}

/** Pluggable at-rest protection for connector OAuth credentials and transient PKCE secrets. */
export interface ConnectorCredentialProtector {
  seal(
    plaintext: Uint8Array,
    context: ConnectorCredentialContext
  ): Promise<SealedConnectorCredential>
  open(
    envelope: SealedConnectorCredential,
    context: ConnectorCredentialContext
  ): Promise<Uint8Array>
}

export interface AesGcmConnectorCredentialProtectorOptions {
  readonly activeKeyId: string
  /** AES-256 keys indexed by stable rotation id. Every key must contain exactly 32 bytes. */
  readonly keys: Readonly<Record<string, Uint8Array>>
}

/** Create a versioned AES-256-GCM credential protector with decrypt-only support for old keys. */
export function createAesGcmConnectorCredentialProtector(
  options: AesGcmConnectorCredentialProtectorOptions
): ConnectorCredentialProtector {
  const activeKeyId = assertNonblank(options.activeKeyId, "active key id")
  const keys = new Map<string, Buffer>()
  for (const [keyId, key] of Object.entries(options.keys)) {
    const normalizedKeyId = assertNonblank(keyId, "key id")
    if (key.byteLength !== 32) {
      throw new ConnectorError(
        `Connector credential key '${normalizedKeyId}' must contain exactly 32 bytes.`
      )
    }
    keys.set(normalizedKeyId, Buffer.from(key))
  }

  if (!keys.has(activeKeyId)) {
    throw new ConnectorError(
      `Connector credential active key '${activeKeyId}' is missing from the key ring.`
    )
  }

  return {
    async seal(plaintext, context) {
      assertCredentialContext(context)
      const key = keys.get(activeKeyId)!
      const nonce = randomBytes(12)
      const cipher = createCipheriv("aes-256-gcm", key, nonce)
      cipher.setAAD(credentialAad(context))
      const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
      return {
        version: 1,
        algorithm: "A256GCM",
        keyId: activeKeyId,
        nonce: nonce.toString("base64url"),
        ciphertext: ciphertext.toString("base64url"),
        tag: cipher.getAuthTag().toString("base64url"),
      }
    },
    async open(envelope, context) {
      assertCredentialContext(context)
      if (envelope.version !== 1 || envelope.algorithm !== "A256GCM") {
        throw new ConnectorError("Connector credential envelope format is not supported.")
      }
      const key = keys.get(envelope.keyId)
      if (!key) {
        throw new ConnectorError(`Connector credential key '${envelope.keyId}' is not configured.`)
      }

      try {
        const nonce = decodeBase64Url(envelope.nonce)
        const ciphertext = decodeBase64Url(envelope.ciphertext)
        const tag = decodeBase64Url(envelope.tag)
        if (nonce.byteLength !== 12 || tag.byteLength !== 16) throw new Error("invalid envelope")
        const decipher = createDecipheriv("aes-256-gcm", key, nonce)
        decipher.setAAD(credentialAad(context))
        decipher.setAuthTag(tag)
        return Buffer.concat([decipher.update(ciphertext), decipher.final()])
      } catch (error) {
        throw new ConnectorError("Connector credential envelope authentication failed.", {
          cause: error,
        })
      }
    },
  }
}

function decodeBase64Url(value: string): Buffer {
  if (!/^[A-Za-z0-9_-]*$/.test(value)) throw new Error("invalid base64url")
  const decoded = Buffer.from(value, "base64url")
  if (decoded.toString("base64url") !== value) throw new Error("non-canonical base64url")
  return decoded
}

export function createEphemeralConnectorCredentialProtector(): ConnectorCredentialProtector {
  return createAesGcmConnectorCredentialProtector({
    activeKeyId: "ephemeral",
    keys: { ephemeral: randomBytes(32) },
  })
}

function credentialAad(context: ConnectorCredentialContext): Buffer {
  return Buffer.from(
    JSON.stringify({
      version: 1,
      projectId: context.projectId,
      connectorId: context.connectorId,
      recordId: context.recordId,
      purpose: context.purpose,
    })
  )
}

function assertCredentialContext(context: ConnectorCredentialContext): void {
  assertNonblank(context.projectId, "context projectId")
  assertNonblank(context.connectorId, "context connectorId")
  assertNonblank(context.recordId, "context recordId")
}

function assertNonblank(value: string, field: string): string {
  if (!value.trim()) {
    throw new ConnectorError(`Connector credential ${field} must not be empty.`)
  }
  return value
}
