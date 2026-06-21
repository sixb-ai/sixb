import { describe, expect, test } from "bun:test"
import {
  createAccessTokenCredential,
  formatAccessTokenValue,
  hashAccessTokenSecret,
  parseAccessTokenValue,
} from "../src"

describe("access token credentials", () => {
  test("formats, parses, and hashes personal access tokens", () => {
    const credential = createAccessTokenCredential("personal", "tok_personal_1")

    expect(credential.tokenValue).toBe(
      formatAccessTokenValue(credential.kind, credential.tokenId, credential.tokenSecret)
    )
    expect(parseAccessTokenValue(credential.tokenValue)).toEqual({
      kind: "personal",
      tokenId: credential.tokenId,
      tokenSecret: credential.tokenSecret,
    })
    expect(credential.tokenHash).toBe(hashAccessTokenSecret(credential.tokenSecret))
    expect(credential.tokenHash).toMatch(/^[a-f0-9]{64}$/)
  })

  test("formats and parses service account access tokens", () => {
    const credential = createAccessTokenCredential("serviceAccount", "tok_service_1")

    expect(credential.tokenValue).toStartWith("sixb_sat_tok_service_1.")
    expect(parseAccessTokenValue(credential.tokenValue)).toEqual({
      kind: "serviceAccount",
      tokenId: credential.tokenId,
      tokenSecret: credential.tokenSecret,
    })
  })

  test("rejects malformed access token values without throwing", () => {
    expect(parseAccessTokenValue(undefined)).toBeNull()
    expect(parseAccessTokenValue("")).toBeNull()
    expect(parseAccessTokenValue("sixb_pat_tok_1")).toBeNull()
    expect(parseAccessTokenValue("sixb_pat_tok_1.secret.extra")).toBeNull()
    expect(parseAccessTokenValue("sixb_pat_bad.secret")).toBeNull()
    expect(parseAccessTokenValue("sixb_unknown_tok_1.secret")).toBeNull()
    expect(parseAccessTokenValue("sixb_pat_tok_1.not.allowed")).toBeNull()
    expect(parseAccessTokenValue("sixb_pat_tok_1.")).toBeNull()
  })

  test("throws clear errors when formatting unsafe values", () => {
    expect(() => formatAccessTokenValue("personal", "bad", "secret")).toThrow(
      "[Sixb] Access token ids must start with 'tok_' and be URL-safe."
    )
    expect(() => formatAccessTokenValue("personal", "tok_1", "not.allowed")).toThrow(
      "[Sixb] Access token secrets must be at least 32 URL-safe characters."
    )
    expect(() => formatAccessTokenValue("personal", "tok_1", "short")).toThrow(
      "[Sixb] Access token secrets must be at least 32 URL-safe characters."
    )
  })
})
