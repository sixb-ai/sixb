import { describe, expect, test } from "bun:test"
import {
  type ConnectorConnectionEncryptionKey,
  createConnectorConnectionEncryptionKey,
  openConnectorSecret,
  type SealedEnvelope,
  type SealedEnvelopeContext,
  sealConnectorSecret,
} from "../src/storage/connector-connections/envelope"

// To prove these still guard the fix, weaken `additionalData` in envelope.ts: drop `recordId`,
// `projectId`, `connectorId`, or `purpose` from the array and the matching rebinding test below
// stops throwing. Removing the `keyId` guard makes "a different key cannot open" fail.

// Built from Buffers so the 32-byte requirement is visible rather than trusted to a literal.
const KEY_A = Buffer.alloc(32, 0xa1).toString("base64")
const KEY_B = Buffer.alloc(32, 0xb2).toString("base64")

const CONTEXT = {
  projectId: "proj_1",
  connectorId: "tiktok",
  recordId: "cca_1",
  purpose: "credentials",
} as const satisfies SealedEnvelopeContext

function key(secret = KEY_A): ConnectorConnectionEncryptionKey {
  return createConnectorConnectionEncryptionKey(secret)
}

describe("connector connection encryption key", () => {
  test("rejects a missing or malformed key so a runtime cannot start without one", () => {
    // A deployment that starts keyless would write credentials it can never read back.
    for (const secret of [undefined, "", "short", Buffer.alloc(31).toString("base64")]) {
      expect(() => createConnectorConnectionEncryptionKey(secret)).toThrow(
        /connectorConnections\.encryptionKey/
      )
    }
  })

  test("derives a stable id that differs between keys", () => {
    expect(key(KEY_A).id).toBe(key(KEY_A).id)
    expect(key(KEY_A).id).not.toBe(key(KEY_B).id)
  })

  test("the key id is not the raw key", () => {
    expect(KEY_A).not.toContain(key(KEY_A).id)
  })
})

describe("sealed envelope", () => {
  test("round-trips a secret and records the sealing key", () => {
    const sealing = key()
    const sealed = sealConnectorSecret(sealing, CONTEXT, "refresh-token-value")

    expect(sealed.version).toBe(1)
    expect(sealed.algorithm).toBe("aes-256-gcm")
    expect(sealed.keyId).toBe(sealing.id)
    expect(openConnectorSecret(sealing, CONTEXT, sealed)).toBe("refresh-token-value")
  })

  test("never stores the plaintext", () => {
    const sealed = sealConnectorSecret(key(), CONTEXT, "refresh-token-value")
    expect(JSON.stringify(sealed)).not.toContain("refresh-token-value")
  })

  test("uses a fresh nonce, so identical secrets do not produce identical rows", () => {
    const sealing = key()
    const first = sealConnectorSecret(sealing, CONTEXT, "same")
    const second = sealConnectorSecret(sealing, CONTEXT, "same")
    expect(first.iv).not.toBe(second.iv)
    expect(first.ciphertext).not.toBe(second.ciphertext)
  })

  test("a different key cannot open it", () => {
    const sealed = sealConnectorSecret(key(KEY_A), CONTEXT, "secret")
    expect(() => openConnectorSecret(key(KEY_B), CONTEXT, sealed)).toThrow(/could not be opened/)
  })

  test.each([
    ["projectId", { ...CONTEXT, projectId: "proj_2" }],
    ["connectorId", { ...CONTEXT, connectorId: "linkedin" }],
    ["recordId", { ...CONTEXT, recordId: "cca_2" }],
    ["purpose", { ...CONTEXT, purpose: "pkceCodeVerifier" as const }],
  ])("a row moved to another %s stops opening", (_field, moved) => {
    // This is the whole point of binding: copying ciphertext between rows must not work.
    const sealing = key()
    const sealed = sealConnectorSecret(sealing, CONTEXT, "secret")
    expect(() => openConnectorSecret(sealing, moved, sealed)).toThrow(/could not be opened/)
  })

  test("tampered ciphertext or tag is rejected rather than partially decrypted", () => {
    const sealing = key()
    const sealed = sealConnectorSecret(sealing, CONTEXT, "secret")
    const flip = (value: string): string => {
      const bytes = Buffer.from(value, "base64")
      bytes[0] = (bytes[0] ?? 0) ^ 0xff
      return bytes.toString("base64")
    }

    for (const tampered of [
      { ...sealed, ciphertext: flip(sealed.ciphertext) },
      { ...sealed, tag: flip(sealed.tag) },
      { ...sealed, iv: flip(sealed.iv) },
    ]) {
      expect(() => openConnectorSecret(sealing, CONTEXT, tampered)).toThrow(/could not be opened/)
    }
  })

  test("an unknown envelope version is refused before any decryption is attempted", () => {
    const sealing = key()
    const sealed = sealConnectorSecret(sealing, CONTEXT, "secret")
    const future = { ...sealed, version: 2 } as unknown as SealedEnvelope
    expect(() => openConnectorSecret(sealing, CONTEXT, future)).toThrow(/could not be opened/)
  })

  test("failure details name the row but never the secret", () => {
    const sealed = sealConnectorSecret(key(KEY_A), CONTEXT, "refresh-token-value")
    try {
      openConnectorSecret(key(KEY_B), CONTEXT, sealed)
      throw new Error("Expected the open to fail")
    } catch (error) {
      const details = (error as { details?: Record<string, unknown> }).details
      expect(details).toMatchObject({ projectId: "proj_1", connectorId: "tiktok" })
      expect(JSON.stringify(details)).not.toContain("refresh-token-value")
      expect(JSON.stringify(details)).not.toContain(sealed.ciphertext)
      expect(JSON.stringify(details)).not.toContain(KEY_A)
    }
  })
})
