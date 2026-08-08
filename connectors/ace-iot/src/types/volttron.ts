import type { AceIotListAllOptions, AceIotPageOptions, AceIotTimestamp } from "./common"

/** An agent wheel stored against a client. */
export interface AceIotVolttronAgentPackage {
  readonly id: string
  readonly package_name: string | null
  readonly object_hash: string | null
  readonly object_path: string | null
  readonly description: string | null
  readonly created: AceIotTimestamp | null
}

export interface AceIotVolttronAgentPackageListOptions extends AceIotPageOptions {
  /** Filter by package name (`voltron_agent_package_name`, spelled that way upstream). */
  readonly packageName?: string
}

export interface AceIotVolttronAgentPackageListAllOptions
  extends AceIotVolttronAgentPackageListOptions,
    AceIotListAllOptions {}

export interface AceIotUploadVolttronAgentPackageInput {
  readonly file: Blob | File
  readonly packageName: string
  readonly description?: string
  /** Filename sent with the upload. Defaults to the file's own name when it has one. */
  readonly filename?: string
}

/** An agent configured on a gateway. */
export interface AceIotVolttronAgent {
  readonly id: string
  readonly identity: string | null
  readonly package_name: string | null
  readonly revision: string | null
  readonly tag: string | null
  readonly active: boolean | null
  readonly package_id: string | null
  readonly updated: AceIotTimestamp | null
  readonly created: AceIotTimestamp | null
}

export interface AceIotVolttronAgentInput {
  readonly identity: string
  readonly package_name?: string
  readonly revision?: string
  readonly tag?: string
  readonly active?: boolean
  readonly volttron_agent_package_id?: string
}

export interface AceIotVolttronAgentListOptions extends AceIotPageOptions {
  readonly volttronAgentIdentity?: string
}

export interface AceIotVolttronAgentListAllOptions
  extends AceIotVolttronAgentListOptions,
    AceIotListAllOptions {}

/** A config blob attached to an agent identity. */
export interface AceIotAgentConfig {
  readonly id: string
  readonly agent_identity: string | null
  readonly config_name: string
  readonly config_hash: string | null
  readonly blob: string | null
  readonly active: boolean | null
  readonly updated: AceIotTimestamp | null
  readonly created: AceIotTimestamp | null
}

export interface AceIotAgentConfigInput {
  readonly agent_identity: string
  /** Defaults to `config` upstream. */
  readonly config_name?: string
  readonly config_hash?: string
  readonly blob?: string
  readonly active?: boolean
}

export interface AceIotAgentConfigListOptions extends AceIotPageOptions {
  readonly agentIdentity?: string
  /** Only active configs. Defaults to true. */
  readonly active?: boolean
  /** Exchange hashes as base64 rather than ASCII hex. Defaults to false. */
  readonly useBase64Hash?: boolean
}

export interface AceIotAgentConfigListAllOptions
  extends AceIotAgentConfigListOptions,
    AceIotListAllOptions {}

export interface AceIotAgentConfigWriteOptions {
  /** Exchange hashes as base64 rather than ASCII hex. Defaults to false. */
  readonly useBase64Hash?: boolean
}

/** An agent together with its active config and linked package. */
export interface AceIotVolttronAgentConfigPackage {
  readonly volttron_agent_package: AceIotVolttronAgentPackage
  readonly volttron_agent: AceIotVolttronAgent
  readonly agent_config: AceIotAgentConfig
}

export interface AceIotCreateVolttronAgentConfigPackageInput {
  readonly volttron_agent: AceIotVolttronAgentInput
  readonly agent_config?: AceIotAgentConfigInput
}

export interface AceIotVolttronAgentConfigPackageOptions {
  /** Base64-encode the agent config blob (`use_agent_config_base64_hash`). Defaults to false. */
  readonly useAgentConfigBase64Hash?: boolean
}
