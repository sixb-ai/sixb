/**
 * Discovery of the project files the Agent reads: Agent Skills under `skills/`, the conversational
 * Agent's instructions in `SIXB.md`, and the hand-written docs and scripts under `ontology/`.
 *
 * Contents are read here, once, so the Agent receives exactly what was validated. Built projects
 * run from their project root with the committed tree, so the same reads work after `sixb build`.
 */

import type { Dirent } from "node:fs"
import { lstat, readdir, readFile, stat } from "node:fs/promises"
import { basename, join, relative, sep } from "node:path"
import type { AgentProjectFile, AgentSkillDefinition } from "../agents/skills"
import type { OntologyDoc } from "../ontology/docs"
import { RuntimeError } from "../runtime/errors"

/** The project's instructions for the conversational Agent, at the project root. */
export const PROJECT_INSTRUCTIONS_FILE = "SIXB.md"

/** They are part of every conversation's prompt, so they stay short. */
const MAX_PROJECT_INSTRUCTIONS_BYTES = 32 * 1024

/** Every sandbox receives them, and every process holds them in memory. */
const MAX_AGENT_FILES_BYTES = 16 * 1024 * 1024

/** Dependency and cache folders, and dotfiles such as `.env`, `.venv`, or `.DS_Store`. */
const IGNORED_NAMES = new Set(["node_modules", "venv", "__pycache__"])

const SKILL_NAME_RE = /^[a-z0-9][a-z0-9._-]*$/
const UNQUOTED_COLON_VALUE_RE = /^\s*[\w-]+:\s+[^\s"'|>].*:\s/

/**
 * Whether a project file, by its POSIX path relative to the project root, is one the Agent reads.
 * `sixb dev` restarts when one changes.
 */
export function isAgentContextPath(path: string): boolean {
  const segments = path.split("/")
  if (segments.some(isIgnoredAgentContextName)) return false
  if (path === PROJECT_INSTRUCTIONS_FILE || segments[0] === "skills") return true
  if (segments[0] !== "ontology") return false
  return isMarkdown(path) || segments.slice(1, -1).some(isOntologyScriptsDirectory)
}

/** Files and folders the Agent never receives, wherever they appear in its directories. */
export function isIgnoredAgentContextName(name: string): boolean {
  return name.startsWith(".") || IGNORED_NAMES.has(name)
}

/** A `scripts/` directory anywhere under `ontology/` holds Agent scripts: mounted, never imported. */
export function isOntologyScriptsDirectory(name: string): boolean {
  return name === "scripts"
}

export interface DiscoveredOntologyFiles {
  /** Markdown under `ontology/`, outside `scripts/` directories. */
  readonly docs: readonly OntologyDoc[]
  /** Every file in a `scripts/` directory under `ontology/`. */
  readonly scripts: readonly AgentProjectFile[]
}

/** Read the hand-written docs and scripts under `ontology/`. Paths are relative to `ontology/`. */
export async function discoverOntologyFiles(projectRoot: string): Promise<DiscoveredOntologyFiles> {
  const ontologyDir = join(projectRoot, "ontology")
  const docs: OntologyDoc[] = []
  const scripts: AgentProjectFile[] = []
  const budget = createFilesBudget("ontology/")

  async function walk(dir: string, inScripts: boolean): Promise<void> {
    let entries: Dirent[]
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch (error) {
      if (isNotFound(error)) return
      throw error
    }

    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (isIgnoredAgentContextName(entry.name)) continue
      const path = join(dir, entry.name)
      const relativePath = toPosixRelative(ontologyDir, path)
      if (entry.isSymbolicLink()) {
        // Module discovery skips symlinks; a folder, doc, or script the Agent would miss fails.
        const target = await stat(path).catch(() => undefined)
        if (inScripts || isMarkdown(entry.name) || target?.isDirectory()) {
          throw new RuntimeError(
            `[Sixb] Ontology path 'ontology/${relativePath}' must not be a symlink.`
          )
        }
        continue
      }
      if (entry.isDirectory()) {
        await walk(path, inScripts || isOntologyScriptsDirectory(entry.name))
        continue
      }
      if (!entry.isFile() || !(inScripts || isMarkdown(entry.name))) continue

      const info = await lstat(path)
      budget(info.size)
      if (inScripts) {
        const mode = info.mode & 0o777
        scripts.push(
          Object.freeze({
            path: relativePath,
            contents: await readFile(path),
            ...((mode & 0o111) === 0 ? {} : { mode }),
          })
        )
      } else {
        const contents = decodeUtf8(await readFile(path))
        if (contents === undefined) {
          throw new RuntimeError(
            `[Sixb] Ontology doc 'ontology/${relativePath}' must be UTF-8 text.`
          )
        }
        docs.push(Object.freeze({ path: relativePath, contents }))
      }
    }
  }

  await walk(ontologyDir, false)
  return { docs, scripts }
}

/** Read and validate every `skills/<name>/` directory. A missing `skills/` has no skills. */
export async function discoverAgentSkills(
  projectRoot: string
): Promise<readonly AgentSkillDefinition[]> {
  const skillsDir = join(projectRoot, "skills")
  let entries: string[]
  try {
    entries = await readdir(skillsDir)
  } catch (error) {
    if (isNotFound(error)) return []
    throw error
  }

  const skills: AgentSkillDefinition[] = []
  const budget = createFilesBudget("skills/")
  for (const entry of entries.sort((a, b) => a.localeCompare(b))) {
    if (isIgnoredAgentContextName(entry)) continue
    const skillDir = join(skillsDir, entry)
    const info = await lstat(skillDir)
    if (info.isSymbolicLink()) {
      throw skillError(projectRoot, skillDir, "Skill directories must not be symlinks.")
    }
    if (!info.isDirectory()) continue
    skills.push(await loadAgentSkill(projectRoot, skillDir, budget))
  }
  return skills
}

/** Read `SIXB.md` when the project has one. */
export async function discoverProjectInstructions(
  projectRoot: string
): Promise<string | undefined> {
  const path = join(projectRoot, PROJECT_INSTRUCTIONS_FILE)
  let info: Awaited<ReturnType<typeof lstat>>
  try {
    info = await lstat(path)
  } catch (error) {
    if (isNotFound(error)) return undefined
    throw error
  }
  if (!info.isFile()) {
    throw instructionsError("must be a regular file, not a symlink or a directory.")
  }
  if (info.size > MAX_PROJECT_INSTRUCTIONS_BYTES) {
    throw instructionsError(
      `is ${info.size.toLocaleString("en-US")} bytes; the limit is ` +
        `${MAX_PROJECT_INSTRUCTIONS_BYTES.toLocaleString("en-US")}. It is part of every ` +
        "conversation's prompt: keep it to project-wide guidance and move task-specific " +
        "instructions into skills/, which the agent reads only when relevant."
    )
  }

  const instructions = decodeUtf8(await readFile(path))
  if (instructions === undefined) throw instructionsError("must be UTF-8 text.")
  if (!instructions.trim()) {
    throw instructionsError("is empty. Write the agent's project instructions or delete the file.")
  }
  return instructions
}

async function loadAgentSkill(
  projectRoot: string,
  skillDir: string,
  budget: FilesBudget
): Promise<AgentSkillDefinition> {
  const files = await collectSkillFiles(projectRoot, skillDir, budget)
  const skillFile = files.find((file) => file.path === "SKILL.md")
  if (!skillFile || typeof skillFile.contents !== "string") {
    throw skillError(projectRoot, skillDir, "Missing required regular SKILL.md.")
  }

  const metadata = parseSkillMetadata(projectRoot, skillDir, skillFile.contents)
  validateSkillMetadata(projectRoot, skillDir, metadata)
  return Object.freeze({
    name: metadata.name,
    description: metadata.description,
    files: Object.freeze(files),
  })
}

interface AgentSkillMetadata {
  readonly name?: string
  readonly description?: string
}

function validateSkillMetadata(
  projectRoot: string,
  skillDir: string,
  metadata: AgentSkillMetadata
): asserts metadata is Required<AgentSkillMetadata> {
  const fail = (message: string) => skillError(projectRoot, skillDir, message)
  if (!metadata.name?.trim()) {
    throw fail("SKILL.md frontmatter must include a non-empty string name.")
  }
  if (!metadata.description?.trim()) {
    throw fail("SKILL.md frontmatter must include a non-empty string description.")
  }
  if (!SKILL_NAME_RE.test(metadata.name)) {
    throw fail(`Skill name '${metadata.name}' must match ${String(SKILL_NAME_RE)}.`)
  }

  const dirName = basename(skillDir)
  if (metadata.name !== dirName) {
    throw fail(`Skill name '${metadata.name}' must match directory '${dirName}'.`)
  }
  if (metadata.name.startsWith("sixb-")) {
    throw fail(`Skill name '${metadata.name}' uses the reserved 'sixb-' prefix.`)
  }
}

async function collectSkillFiles(
  projectRoot: string,
  skillDir: string,
  budget: FilesBudget,
  currentDir = skillDir
): Promise<AgentProjectFile[]> {
  const files: AgentProjectFile[] = []
  const entries = await readdir(currentDir)
  for (const entry of entries.sort((a, b) => a.localeCompare(b))) {
    if (isIgnoredAgentContextName(entry)) continue
    const path = join(currentDir, entry)
    const info = await lstat(path)
    const relativePath = toPosixRelative(skillDir, path)
    if (info.isSymbolicLink()) {
      throw skillError(projectRoot, skillDir, `Skill file '${relativePath}' must not be a symlink.`)
    }
    if (info.isDirectory()) {
      files.push(...(await collectSkillFiles(projectRoot, skillDir, budget, path)))
      continue
    }
    if (!info.isFile()) continue
    budget(info.size)

    const mode = info.mode & 0o777
    files.push(
      Object.freeze({
        path: relativePath,
        contents:
          relativePath === "SKILL.md" ? await readFile(path, "utf-8") : await readFile(path),
        ...((mode & 0o111) === 0 ? {} : { mode }),
      })
    )
  }
  return files
}

function parseSkillMetadata(
  projectRoot: string,
  skillDir: string,
  markdown: string
): AgentSkillMetadata {
  const fail = (message: string) => skillError(projectRoot, skillDir, message)
  const lines = markdown.replaceAll("\r\n", "\n").split("\n")
  if (lines[0] !== "---") {
    throw fail("SKILL.md must start with YAML frontmatter delimited by ---.")
  }

  const end = lines.findIndex((line, index) => index > 0 && line === "---")
  if (end < 0) {
    throw fail("SKILL.md frontmatter is missing the closing --- delimiter.")
  }

  const frontmatter = lines.slice(1, end)
  let parsed: unknown
  try {
    parsed = Bun.YAML.parse(frontmatter.join("\n"))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    // The usual culprit: `description: Use when: ...` reads as a nested mapping.
    const hint = frontmatter.some((line) => UNQUOTED_COLON_VALUE_RE.test(line))
      ? ` Quote values that contain ': ', for example description: "Use when: ...".`
      : ""
    throw fail(`SKILL.md frontmatter is not valid YAML: ${message}.${hint}`)
  }
  if (!isRecord(parsed)) {
    throw fail("SKILL.md frontmatter must be a YAML mapping.")
  }

  return {
    ...(typeof parsed.name === "string" ? { name: parsed.name.trim() } : {}),
    ...(typeof parsed.description === "string" ? { description: parsed.description.trim() } : {}),
  }
}

/** Counts the bytes of one family's files and fails once they exceed the limit. */
type FilesBudget = (size: number) => void

function createFilesBudget(directory: string): FilesBudget {
  let total = 0
  return (size) => {
    total += size
    if (total > MAX_AGENT_FILES_BYTES) {
      throw new RuntimeError(
        `[Sixb] The files under ${directory} exceed ${MAX_AGENT_FILES_BYTES / 1024 / 1024} MB. ` +
          "Every agent sandbox receives them: keep large assets out of the project, or have a " +
          "script fetch them when needed."
      )
    }
  }
}

function isMarkdown(path: string): boolean {
  return path.toLowerCase().endsWith(".md")
}

function decodeUtf8(bytes: Uint8Array): string | undefined {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes)
  } catch {
    return undefined
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function toPosixRelative(from: string, to: string): string {
  return relative(from, to).split(sep).join("/")
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT"
}

function skillError(projectRoot: string, skillDir: string, message: string): RuntimeError {
  return new RuntimeError(
    `[Sixb] Agent Skill '${toPosixRelative(projectRoot, skillDir)}' is invalid: ${message}`
  )
}

function instructionsError(message: string): RuntimeError {
  return new RuntimeError(`[Sixb] ${PROJECT_INSTRUCTIONS_FILE} ${message}`)
}
