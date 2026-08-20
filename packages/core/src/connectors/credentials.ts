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

/** Create credential protection from the base64url key exposed by Sixb configuration. */
export function createConnectorCredentialProtectorFromKey(
  encodedKey: string
): ConnectorCredentialProtector {
  let key: Buffer
  try {
    key = decodeBase64Url(encodedKey)
  } catch (error) {
    throw new ConnectorError(
      "connectorConnections.encryptionKey must be canonical base64url encoding.",
      { cause: error }
    )
  }
  if (key.byteLength !== 32) {
    throw new ConnectorError(
      "connectorConnections.encryptionKey must encode exactly 32 random bytes."
    )
  }
  return createAesGcmConnectorCredentialProtector(key)
}

function createAesGcmConnectorCredentialProtector(
  encryptionKey: Uint8Array
): ConnectorCredentialProtector {
  if (encryptionKey.byteLength !== 32) {
    throw new ConnectorError("Connector credential encryption key must contain exactly 32 bytes.")
  }
  const key = Buffer.from(encryptionKey)

  return {
    async seal(plaintext, context) {
      assertCredentialContext(context)
      const nonce = randomBytes(12)
      const cipher = createCipheriv("aes-256-gcm", key, nonce)
      cipher.setAAD(credentialAad(context))
      const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
      return {
        version: 1,
        algorithm: "A256GCM",
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
  return createAesGcmConnectorCredentialProtector(randomBytes(32))
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
