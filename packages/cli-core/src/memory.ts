import { createHash } from "node:crypto"

/**
 * The Agent's memory as installed in its sandbox: the worker writes each repo under
 * `$SIXB_MEMORY_DIR/<repo>/` with a manifest of what it loaded, and `sixb memory` saves the files
 * that differ from it.
 */
export type AgentMemoryRepo = "user" | "project"

/** Where the manifest is, relative to `$SIXB_CONTEXT_DIR`. */
export const AGENT_MEMORY_MANIFEST = "context/memory.json"

export const AGENT_MEMORY_ENTRY = "MEMORY.md"

/** What a repo starts from before its first save; it is saved with the first save. */
export const AGENT_MEMORY_STARTER = "# Memory\n\n"

/** What the local copy was loaded from: the revision and each file's SHA-256, by path. */
export interface AgentMemoryManifest {
  readonly repos: Partial<Record<AgentMemoryRepo, AgentMemoryManifestRepo>>
}

export interface AgentMemoryManifestRepo {
  readonly revision: number
  readonly files: Readonly<Record<string, string>>
}

export function agentMemoryFileHash(contents: string): string {
  return createHash("sha256").update(contents).digest("hex")
}
