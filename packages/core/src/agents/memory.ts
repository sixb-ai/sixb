/**
 * Agent memory repos: a folder of linked Markdown files with `MEMORY.md` as the entry point, in the
 * Agent Memory Repo format. These rules decide what a save may contain before it reaches storage.
 */

import type { Principal } from "../auth"
import type { AgentMemoryChange, AgentMemoryFile } from "../storage/agents"
import { AgentMemoryError } from "./errors"

/** The two repos a conversation reaches: its user's own, and the one the project shares. */
export type AgentMemoryRepoName = "user" | "project"

export const AGENT_MEMORY_REPO_NAMES: readonly AgentMemoryRepoName[] = ["user", "project"]

/** The file every repo starts from, and the one rendered into every conversation's prompt. */
export const AGENT_MEMORY_ENTRY = "MEMORY.md"

export const AGENT_MEMORY_LIMITS = {
  /** `MEMORY.md` is part of every prompt. */
  entryBytes: 16 * 1024,
  fileBytes: 256 * 1024,
  repoBytes: 4 * 1024 * 1024,
  pathLength: 256,
  messageLength: 500,
} as const

/** A link to a path that is not in the repo, found in one of its Markdown files. */
export interface AgentMemoryLinkWarning {
  /** The file the link is in. */
  readonly path: string
  readonly link: string
}

const encoder = new TextEncoder()

/**
 * The storage id of a repo: `user:<userId>` or `project`. A caller with no user of its own keeps
 * its memory as `system:<id>`: a project without auth, or app code running as the system, which
 * then reads a repo no signed-in user's conversation does.
 */
export function agentMemoryRepoId(repo: AgentMemoryRepoName, owner: Principal | null): string {
  if (repo === "project") return "project"
  if (!owner || owner.type === "serviceAccount") {
    throw new AgentMemoryError(
      "not_allowed",
      "[Sixb] Agent memory of its own belongs to a signed-in user."
    )
  }
  return `${owner.type}:${owner.id}`
}

export function parseAgentMemoryRepoName(value: string): AgentMemoryRepoName {
  if (value === "user" || value === "project") return value
  throw new AgentMemoryError(
    "invalid_repo",
    `[Sixb] Agent memory repo '${value}' does not exist. Use 'user' or 'project'.`
  )
}

/** Why a path cannot hold a memory file, or `null` when it can. */
export function agentMemoryPathProblem(path: string): string | null {
  if (path.length === 0) return "is empty"
  if (path.length > AGENT_MEMORY_LIMITS.pathLength) {
    return `is longer than ${AGENT_MEMORY_LIMITS.pathLength} characters`
  }
  if (/[\u0000-\u001f\u007f\\]/.test(path)) return "contains a backslash or a control character"
  if (path.startsWith("/")) return "is absolute; paths start at the repo root"
  const segments = path.split("/")
  if (segments.some((segment) => segment.length === 0)) return "has an empty segment"
  if (segments.some((segment) => segment === "." || segment === "..")) {
    return "has a '.' or '..' segment"
  }
  if (segments.some((segment) => segment.startsWith("."))) return "names a dotfile"
  if (path.endsWith(".theirs")) return "is a conflict copy; merge it into its file and delete it"
  return null
}

/**
 * Apply `changes` to the repo's current files and check the result, so a save is rejected with
 * an error the Agent can act on. Returns the repo as the save leaves it.
 */
export function applyAgentMemoryChanges(
  current: readonly AgentMemoryFile[],
  message: string,
  changes: readonly AgentMemoryChange[]
): AgentMemoryFile[] {
  const fail = (detail: string): never => {
    throw new AgentMemoryError("invalid_save", `[Sixb] Agent memory ${detail}`)
  }

  if (message.trim().length === 0) fail("save needs a message saying what was learned.")
  if (message.length > AGENT_MEMORY_LIMITS.messageLength) {
    fail(`save message is longer than ${AGENT_MEMORY_LIMITS.messageLength} characters.`)
  }
  if (changes.length === 0) fail("save changes no file.")

  const files = new Map(current.map((file) => [file.path, file.contents]))
  const seen = new Set<string>()
  for (const change of changes) {
    const problem = agentMemoryPathProblem(change.path)
    if (problem) fail(`path '${change.path}' ${problem}.`)
    if (seen.has(change.path)) fail(`save changes '${change.path}' more than once.`)
    seen.add(change.path)

    if (change.contents === null) {
      files.delete(change.path)
      continue
    }
    if (change.contents.includes("\u0000")) fail(`file '${change.path}' is not text.`)
    const bytes = encoder.encode(change.contents).byteLength
    if (change.path === AGENT_MEMORY_ENTRY && bytes > AGENT_MEMORY_LIMITS.entryBytes) {
      fail(
        `${AGENT_MEMORY_ENTRY} is over ${kilobytes(AGENT_MEMORY_LIMITS.entryBytes)}, and it is part of every prompt. Move entries into topic files and link them.`
      )
    }
    if (bytes > AGENT_MEMORY_LIMITS.fileBytes) {
      fail(`file '${change.path}' is over ${kilobytes(AGENT_MEMORY_LIMITS.fileBytes)}.`)
    }
    files.set(change.path, change.contents)
  }

  if (!files.has(AGENT_MEMORY_ENTRY)) {
    fail(`repo must keep its ${AGENT_MEMORY_ENTRY}.`)
  }
  let total = 0
  for (const contents of files.values()) total += encoder.encode(contents).byteLength
  if (total > AGENT_MEMORY_LIMITS.repoBytes) {
    fail(
      `repo would be over ${kilobytes(AGENT_MEMORY_LIMITS.repoBytes)}. Remove entries that are cheap to look up again.`
    )
  }

  return [...files].map(([path, contents]) => ({ path, contents }))
}

/**
 * Links in the repo's Markdown files that point at no file. A `[[target]]` names a path from the
 * repo root, with `.md` left out and any other extension kept.
 */
export function findBrokenAgentMemoryLinks(
  files: readonly AgentMemoryFile[]
): AgentMemoryLinkWarning[] {
  const paths = new Set(files.map((file) => file.path))
  const warnings: AgentMemoryLinkWarning[] = []
  for (const file of files) {
    if (!file.path.endsWith(".md")) continue
    for (const link of agentMemoryLinks(file.contents)) {
      if (!paths.has(agentMemoryLinkPath(link))) warnings.push({ path: file.path, link })
    }
  }
  return warnings.sort((left, right) =>
    left.path === right.path ? compare(left.link, right.link) : compare(left.path, right.path)
  )
}

/** The distinct `[[link]]` targets in a Markdown file, in the order they first appear. */
export function agentMemoryLinks(contents: string): string[] {
  const links = new Set<string>()
  for (const match of contents.matchAll(/\[\[([^[\]\n]+)\]\]/g)) {
    const link = match[1]?.trim()
    if (link) links.add(link)
  }
  return [...links]
}

/** The file a link names: `.md` is added unless its last segment already has an extension. */
export function agentMemoryLinkPath(link: string): string {
  const name = link.slice(link.lastIndexOf("/") + 1)
  return name.includes(".") ? link : `${link}.md`
}

function kilobytes(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${bytes / (1024 * 1024)} MB` : `${bytes / 1024} KB`
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}
