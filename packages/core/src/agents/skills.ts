import { RuntimeError } from "../runtime/errors"

/** A project file the Agent receives byte-for-byte in its sandbox. */
export interface AgentProjectFile {
  /** POSIX path, relative to the directory the file is installed in. */
  readonly path: string
  readonly contents: string | Uint8Array
  /** Permission bits, kept only for executable files. */
  readonly mode?: number
}

/** An Agent Skill read from `skills/<name>/SKILL.md` and the files next to it. */
export interface AgentSkillDefinition {
  readonly name: string
  readonly description: string
  /** Every file of the skill directory, `SKILL.md` included. */
  readonly files: readonly AgentProjectFile[]
}

/** Immutable catalog of the Agent Skills registered with a Sixb host. */
export interface AgentSkillCatalog {
  list(): readonly AgentSkillDefinition[]
  getByName(name: string): AgentSkillDefinition | null
}

/** Index skills by name. Discovery validates each skill; names must also be unique. */
export function createAgentSkillCatalog(
  definitions: readonly AgentSkillDefinition[] | undefined
): AgentSkillCatalog {
  const skills = Object.freeze([...(definitions ?? [])])
  const skillsByName = new Map<string, AgentSkillDefinition>()
  for (const skill of skills) {
    if (skillsByName.has(skill.name)) {
      throw new RuntimeError(`[Sixb] Duplicate Agent Skill name: ${skill.name}`)
    }
    skillsByName.set(skill.name, skill)
  }

  return Object.freeze({
    list: () => skills,
    getByName: (name: string) => skillsByName.get(name) ?? null,
  })
}
