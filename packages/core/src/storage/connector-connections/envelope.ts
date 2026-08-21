/**
 * Authenticated encryption for connector credentials.
 *
 * Every other secret in Sixb is hashed at rest: an access token, a session, a magic link are all
 * one-way, so a stolen row proves nothing. OAuth credentials are the first secrets that have to be
 * *recovered* to be useful, so hashing is not available and the material has to be sealed instead.
 *
 * This module imports `node:crypto` and must stay off any path a browser bundle can reach. It is
 * only ever called from the runtime; storage providers persist a `SealedEnvelope` without opening
 * it, which keeps the key out of every provider and out of the shared contract suite.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto"
import { createSixbError } from "../../errors/internal"

const ENVELOPE_VERSION = 1
const ALGORITHM = "aes-256-gcm"
const KEY_BYTES = 32
const IV_BYTES = 12
const KEY_ID_DOMAIN = "sixb.connector-connections.key-id.v1"

/**
 * One sealed secret, as it sits in a single storage column.
 *
 * A structured record rather than a compact string: a string alias would let a raw access token be
 * assigned to a credentials field and still compile. `keyId` records which key sealed the row so a
 * later key rotation can find what it must re-seal without a schema change.
 */
export interface SealedEnvelope {
  readonly version: typeof ENVELOPE_VERSION
  readonly algorithm: typeof ALGORITHM
  readonly keyId: string
  /** base64, 12 random bytes, fresh for every seal. */
  readonly iv: string
  readonly ciphertext: string
  /** base64 GCM authentication tag. */
  readonly tag: string
}

/**
 * What a sealed secret is. Sealing binds it, so a PKCE verifier can never be opened as a
 * credential even though both live in the same table shape.
 */
export type SealedEnvelopePurpose = "credentials" | "pkceCodeVerifier"

/** The immutable row identity a sealed secret is bound to. */
export interface SealedEnvelopeContext {
  readonly projectId: string
  readonly connectorId: string
  /** Id of the record that owns the envelope. */
  readonly recordId: string
  readonly purpose: SealedEnvelopePurpose
}

declare const encryptionKeyBrand: unique symbol

/**
 * A validated sealing key.
 *
 * The brand is the point: `createConnectorConnectionEncryptionKey` is the only way to obtain the
 * type, so a runtime without a configured key cannot construct one, cannot seal, and cannot open.
 * There is no path that silently degrades to plaintext.
 */
export interface ConnectorConnectionEncryptionKey {
  readonly [encryptionKeyBrand]: true
  readonly id: string
  readonly material: Buffer
}

/**
 * Validates a configured secret and derives its key id.
 *
 * Refusing here is the point: an OAuth deployment that starts without a usable key would write
 * credentials it can never read back. `webhooks/unverified.ts` takes the same posture for webhook
 * secrets — fail construction rather than start in a state that looks fine until it matters.
 */
export function createConnectorConnectionEncryptionKey(
  secret: string | undefined
): ConnectorConnectionEncryptionKey {
  if (secret === undefined || secret.length === 0) {
    throw createSixbError(
      "connector.encryption_key_invalid",
      "[Sixb] connectorConnections.encryptionKey is required to store connector credentials. Generate one with `openssl rand -base64 32`."
    )
  }

  const material = Buffer.from(secret, "base64")
  if (material.byteLength !== KEY_BYTES) {
    throw createSixbError(
      "connector.encryption_key_invalid",
      `[Sixb] connectorConnections.encryptionKey must decode to ${KEY_BYTES} bytes, received ${material.byteLength}. Generate one with \`openssl rand -base64 32\`.`
    )
  }

  return {
    id: keyIdFor(material),
    material,
  } as ConnectorConnectionEncryptionKey
}

/** Seals one secret against its row identity. */
export function sealConnectorSecret(
  key: ConnectorConnectionEncryptionKey,
  context: SealedEnvelopeContext,
  plaintext: string
): SealedEnvelope {
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv(ALGORITHM, key.material, iv)
  cipher.setAAD(additionalData(key.id, context))
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()])

  return {
    version: ENVELOPE_VERSION,
    algorithm: ALGORITHM,
    keyId: key.id,
    iv: iv.toString("base64"),
    ciphertext: ciphertext.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
  }
}

/**
 * Opens a sealed secret, or throws.
 *
 * Never returns `null` or a partial result. A nullable return invites `?? fallback` at the call
 * site, and a fallback on this path is a silent downgrade to no encryption at all.
 */
export function openConnectorSecret(
  key: ConnectorConnectionEncryptionKey,
  context: SealedEnvelopeContext,
  envelope: SealedEnvelope
): string {
  if (envelope.version !== ENVELOPE_VERSION || envelope.algorithm !== ALGORITHM) {
    throw unreadable(context, "unsupported_envelope")
  }
  if (envelope.keyId !== key.id) {
    throw unreadable(context, "key_mismatch")
  }

  try {
    const decipher = createDecipheriv(ALGORITHM, key.material, Buffer.from(envelope.iv, "base64"))
    decipher.setAAD(additionalData(envelope.keyId, context))
    decipher.setAuthTag(Buffer.from(envelope.tag, "base64"))
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(envelope.ciphertext, "base64")),
      decipher.final(),
    ])
    return plaintext.toString("utf8")
  } catch (error) {
    throw unreadable(context, "authentication_failed", error)
  }
}

/**
 * The additional data every envelope authenticates but never stores.
 *
 * Reconstructing it at open time is what makes the binding a real check rather than a copied
 * assertion: a row moved to another project, connector, record, or purpose stops opening. The
 * version and key id are inside the tag too, so a future v2 cannot be down-negotiated to v1.
 */
function additionalData(keyId: string, context: SealedEnvelopeContext): Buffer {
  return Buffer.from(
    JSON.stringify([
      ENVELOPE_VERSION,
      keyId,
      context.purpose,
      context.projectId,
      context.connectorId,
      context.recordId,
    ]),
    "utf8"
  )
}

function keyIdFor(material: Buffer): string {
  return createHash("sha256")
    .update(KEY_ID_DOMAIN)
    .update(material)
    .digest("base64url")
    .slice(0, 16)
}

/**
 * `details` names the row, never the secret. `parseSixbFailure` copies `details` verbatim into
 * `onError` reports and HTTP responses, so ciphertext and key material must not appear here.
 */
function unreadable(context: SealedEnvelopeContext, reason: string, cause?: unknown) {
  return createSixbError(
    "connector.credentials_unreadable",
    "[Sixb] A sealed connector secret could not be opened.",
    {
      cause,
      details: {
        projectId: context.projectId,
        connectorId: context.connectorId,
        recordId: context.recordId,
        purpose: context.purpose,
        reason,
      },
    }
  )
}
