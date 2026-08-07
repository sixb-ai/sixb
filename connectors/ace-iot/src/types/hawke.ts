import type { AceIotListAllOptions, AceIotPageOptions, AceIotTimestamp } from "./common"

export interface AceIotHawkeConfig {
  readonly content_hash: string | null
  readonly content_blob: string | null
  readonly updated: AceIotTimestamp | null
  readonly created: AceIotTimestamp | null
}

/** A Hawke config as returned in a listing, which names the agent it belongs to. */
export interface AceIotHawkeConfigWithIdentity extends AceIotHawkeConfig {
  readonly hawke_identity: string | null
}

/** The writable fields of a Hawke config. `updated` and `created` are read-only upstream. */
export interface AceIotHawkeConfigBaseInput {
  readonly content_hash?: string
  readonly content_blob?: string
}

/** A Hawke config in a batch write, which has to name the agent it belongs to. */
export interface AceIotHawkeConfigInput extends AceIotHawkeConfigBaseInput {
  readonly hawke_identity: string
}

export interface AceIotHawkeConfigListOptions extends AceIotPageOptions {
  /** Retrieve one specific config by hash. */
  readonly hash?: string
  /** Exchange hashes as base64 rather than ASCII hex. Defaults to false. */
  readonly useBase64Hash?: boolean
}

export interface AceIotHawkeConfigListAllOptions
  extends AceIotHawkeConfigListOptions,
    AceIotListAllOptions {}

export interface AceIotHawkeConfigOptions {
  readonly hash?: string
  readonly useBase64Hash?: boolean
}

export interface AceIotHawkeConfigWriteOptions {
  readonly useBase64Hash?: boolean
}
