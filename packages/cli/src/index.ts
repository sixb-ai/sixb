export type { ApiClientOptions, HttpMethod } from "./api-client"
export { ApiClient } from "./api-client"
export { requestsHelp } from "./arguments"
export type { CliAssets } from "./cli-assets"
export { loadCliAssets } from "./cli-assets"
export type { CommandCategory, CommandEntry, InstanceCommand } from "./commands"
export { COMMAND_REGISTRY, INSTANCE_COMMANDS, isInstanceCommand } from "./commands"
export { login, logout, profile } from "./commands/auth"
export { renderInstanceHelp } from "./commands/metadata"
export type { StatusContext, StatusReport } from "./commands/status"
export { fetchStatus, status } from "./commands/status"
export {
  findProjectCli,
  PROJECT_COMMANDS,
  type ProjectCliTarget,
  runProjectCli,
} from "./delegate"
export {
  formatGroups,
  formatShortDate,
  type KeyValueItem,
  renderKeyValues,
  renderOutput,
  renderTable,
  style,
  type TableOptions,
  wantsJson,
} from "./format"
export type { AgentMemoryManifest, AgentMemoryRepo } from "./memory"
export {
  AGENT_MEMORY_ENTRY,
  AGENT_MEMORY_MANIFEST,
  AGENT_MEMORY_STARTER,
  agentMemoryFileHash,
} from "./memory"
export {
  CliError,
  EXIT_API,
  EXIT_AWAITING_APPROVAL,
  EXIT_USAGE,
  fail,
  INSTANCE_CLI_VERSION,
  reportError,
  writeJson,
  writeText,
} from "./output"
export {
  assertProfileName,
  type ProfileStoreOptions,
  ProfileUnansweredError,
  profileSessionStore,
  type ResolvedProfile,
  type ResolveProfileInput,
  readConfig,
  requireProfile,
  resolveConfigPath,
  resolveProfile,
  type SixbConfigFile,
  type SixbProfile,
  updateConfig,
} from "./profiles"
export type { ApiConnection, RunInstanceCliInput } from "./run"
export { createInstanceApiClient, runInstanceCli } from "./run"
export {
  getSessionAccessToken,
  normalizeApiUrl,
  type SixbDeviceLogin,
  SixbSessionEndedError,
  type SixbSessionStore,
  type SixbSessionTokens,
  signOutSession,
  startDeviceLogin,
} from "./session"
