import { lstat, readdir, readFile } from "node:fs/promises"
import { basename, join, relative, sep } from "node:path"
import { fileURLToPath } from "node:url"
import type { SandboxFileRecord } from "@sixb/core"

export interface AgentSkillFile {
  readonly relativePath: string
  readonly contents: string | Uint8Array
  readonly mode?: number
}

export interface AgentSkill {
  readonly name: string
  readonly description: string
  readonly files: readonly AgentSkillFile[]
}

interface AgentSkillMetadata {
  readonly name?: string
  readonly description?: string
}

const SKILL_NAME_RE = /^[a-z0-9][a-z0-9._-]*$/
const BUNDLED_SKILLS_DIR = fileURLToPath(new URL("./skills/", import.meta.url))

export async function loadAgentSkills(
  input: { readonly projectSkillsDir?: string | false } = {}
): Promise<readonly AgentSkill[]> {
  const bundledSkills = await loadSkillsDirectory(BUNDLED_SKILLS_DIR, { source: "bundled" })
  if (input.projectSkillsDir === false || input.projectSkillsDir === undefined) {
    return bundledSkills
  }

  const projectSkills = await loadSkillsDirectory(input.projectSkillsDir, {
    source: "project",
    missingAllowed: true,
    builtInNames: new Set(bundledSkills.map((skill) => skill.name)),
  })
  return [...bundledSkills, ...projectSkills]
}

/**
 * Build the file records that install the agent skills into a sandbox. Returns records targeting
 * `<skillsDir>/<name>/...`, ready to hand to {@link Sandbox.writeFiles}.
 */
export function buildAgentSkillFiles(
  skillsDir: string,
  skills: readonly AgentSkill[]
): readonly SandboxFileRecord[] {
  return skills.flatMap((skill) =>
    skill.files.map((file) => ({
      path: join(skillsDir, skill.name, file.relativePath),
      contents: file.contents,
      ...(file.mode === undefined ? {} : { mode: file.mode }),
    }))
  )
}

export function renderAgentSkillCatalog(skills: readonly AgentSkill[]): string {
  return [
    "Sixb API access is available from the sandboxed bash tool through a per-run gateway URL.",
    "Agent Skills are installed under $SIXB_SKILLS_DIR.",
    "Message attachments, when present, are listed in $SIXB_ATTACHMENTS and materialized under $SIXB_ATTACHMENT_DIR when size limits allow.",
    "Prepare user-facing files under $SIXB_OUTPUT_STAGING_DIR, then atomically publish each complete file or directory with mv into $SIXB_OUTPUT_DIR. Only files under $SIXB_OUTPUT_DIR are attached to the final chat message when size limits allow.",
    "Never write a file directly in $SIXB_OUTPUT_DIR and never modify it after publication; publish only complete outputs.",
    "Use $SIXB_SKILLS_DIR and attachment/output env vars to reference file paths; do not hardcode sandbox directory paths.",
    "Before applying a matching skill, read that skill's SKILL.md with bash/cat.",
    "Load referenced files only when needed.",
    "Use live ontology and object APIs rather than guessing schema or relying on stale context.",
    "Do not add Authorization or Cookie headers. The gateway authenticates allowed requests.",
    [
      "Operate through the ontology layer: object types, object reads/queries, telemetry reads,",
      "file publication, and declared actions or workflows.",
    ].join(" "),
    "",
    "Available Agent Skills:",
    ...skills.map(
      (skill) => `- ${skill.name}: ${skill.description} Path: $SIXB_SKILLS_DIR/${skill.name}`
    ),
  ].join("\n")
}

interface LoadSkillsDirectoryOptions {
  readonly source: "bundled" | "project"
  readonly missingAllowed?: boolean
  readonly builtInNames?: ReadonlySet<string>
}

async function loadSkillsDirectory(
  skillsDir: string,
  options: LoadSkillsDirectoryOptions
): Promise<readonly AgentSkill[]> {
  let entries: string[]
  try {
    entries = await readdir(skillsDir)
  } catch (error) {
    if (options.missingAllowed && isNotFound(error)) {
      return []
    }
    throw error
  }

  const skills: AgentSkill[] = []
  for (const entry of entries.sort((a, b) => a.localeCompare(b))) {
    const skillDir = join(skillsDir, entry)
    const info = await lstat(skillDir)
    if (info.isSymbolicLink()) {
      throw skillError(skillDir, "Skill directories must not be symlinks.")
    }
    if (!info.isDirectory()) {
      continue
    }
    skills.push(await loadAgentSkill(skillDir, options))
  }
  return skills
}

async function loadAgentSkill(
  skillDir: string,
  options: LoadSkillsDirectoryOptions
): Promise<AgentSkill> {
  const files = await collectSkillFiles(skillDir)
  const skillFile = files.find((file) => file.relativePath === "SKILL.md")
  if (!skillFile || typeof skillFile.contents !== "string") {
    throw skillError(skillDir, "Missing required regular SKILL.md.")
  }

  const metadata = parseSkillMetadata(skillFile.contents, skillDir)
  validateSkillMetadata(skillDir, metadata, options)
  return {
    name: metadata.name,
    description: metadata.description,
    files,
  }
}

function validateSkillMetadata(
  skillDir: string,
  metadata: AgentSkillMetadata,
  options: LoadSkillsDirectoryOptions
): asserts metadata is Required<AgentSkillMetadata> {
  if (!metadata.name?.trim()) {
    throw skillError(skillDir, "SKILL.md frontmatter must include a non-empty string name.")
  }
  if (!metadata.description?.trim()) {
    throw skillError(skillDir, "SKILL.md frontmatter must include a non-empty string description.")
  }
  if (!SKILL_NAME_RE.test(metadata.name)) {
    throw skillError(skillDir, `Skill name '${metadata.name}' must match ${String(SKILL_NAME_RE)}.`)
  }

  const dirName = basename(skillDir)
  if (metadata.name !== dirName) {
    throw skillError(skillDir, `Skill name '${metadata.name}' must match directory '${dirName}'.`)
  }
  if (options.source === "project" && options.builtInNames?.has(metadata.name)) {
    throw skillError(
      skillDir,
      `Skill name '${metadata.name}' collides with a built-in agent skill.`
    )
  }
  if (options.source === "project" && metadata.name.startsWith("sixb-")) {
    throw skillError(skillDir, `Skill name '${metadata.name}' uses the reserved 'sixb-' prefix.`)
  }
}

async function collectSkillFiles(
  skillDir: string,
  currentDir = skillDir
): Promise<readonly AgentSkillFile[]> {
  const files: AgentSkillFile[] = []
  const entries = await readdir(currentDir)
  for (const entry of entries.sort((a, b) => a.localeCompare(b))) {
    const path = join(currentDir, entry)
    const info = await lstat(path)
    const relativePath = toPosixRelative(skillDir, path)
    if (info.isSymbolicLink()) {
      throw skillError(skillDir, `Skill file '${relativePath}' must not be a symlink.`)
    }
    if (info.isDirectory()) {
      files.push(...(await collectSkillFiles(skillDir, path)))
      continue
    }
    if (!info.isFile()) {
      continue
    }

    const mode = info.mode & 0o777
    files.push({
      relativePath,
      contents: relativePath === "SKILL.md" ? await readFile(path, "utf-8") : await readFile(path),
      ...((mode & 0o111) === 0 ? {} : { mode }),
    })
  }
  return files
}

function parseSkillMetadata(markdown: string, skillDir: string): AgentSkillMetadata {
  const lines = markdown.replaceAll("\r\n", "\n").split("\n")
  if (lines[0] !== "---") {
    throw skillError(skillDir, "SKILL.md must start with YAML frontmatter delimited by ---.")
  }

  const end = lines.findIndex((line, index) => index > 0 && line === "---")
  if (end < 0) {
    throw skillError(skillDir, "SKILL.md frontmatter is missing the closing --- delimiter.")
  }

  let parsed: unknown
  try {
    parsed = Bun.YAML.parse(lines.slice(1, end).join("\n"))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw skillError(skillDir, `SKILL.md frontmatter is not valid YAML: ${message}`)
  }
  if (!isRecord(parsed)) {
    throw skillError(skillDir, "SKILL.md frontmatter must be a YAML mapping.")
  }

  return {
    ...(typeof parsed.name === "string" ? { name: parsed.name.trim() } : {}),
    ...(typeof parsed.description === "string" ? { description: parsed.description.trim() } : {}),
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

function skillError(skillDir: string, message: string): Error {
  return new Error(`[SixbAgentWorker] Agent skill '${skillDir}' is invalid: ${message}`)
}
