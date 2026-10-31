import { posix } from "node:path"
import type { Sandbox } from "@sixb/core"

/** The sandbox plus its run-scoped environment, resolved lazily when first needed. */
export interface AgentSandboxHandle {
  readonly sandbox: Sandbox
  /**
   * Where the run's files are installed: skills, ontology docs, memory, attachments, artifacts,
   * children's files and the agent's `sixb`. As the agent names it: relative to the working
   * directory, or absolute.
   */
  readonly contextDirectory: string
  readonly env?: Readonly<Record<string, string>>
}

/** A path in the run's context directory, absolute in the sandbox. */
export function contextPath(handle: AgentSandboxHandle, ...segments: string[]): string {
  return posix.resolve(handle.sandbox.workingDirectory, handle.contextDirectory, ...segments)
}
