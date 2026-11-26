export type { ApiClientOptions, HttpMethod } from "./api-client"
export { ApiClient } from "./api-client"
export { requestsHelp } from "./arguments"
export type { CommandCategory, CommandEntry, InstanceCommand } from "./commands"
export { COMMAND_REGISTRY, INSTANCE_COMMANDS, isInstanceCommand } from "./commands"
export { renderInstanceHelp } from "./commands/metadata"
export type { StatusContext, StatusReport } from "./commands/status"
export { fetchStatus, status } from "./commands/status"
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
export type { ApiConnection, RunInstanceCliInput } from "./run"
export { createInstanceApiClient, runInstanceCli } from "./run"
export type { SandboxCliAssets } from "./sandbox-cli"
export { loadSandboxCliAssets } from "./sandbox-cli"
