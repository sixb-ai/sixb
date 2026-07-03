import { readFile } from "node:fs/promises"
import { join } from "node:path"
import type { SandboxFileRecord } from "@sixb/core"

interface AgentSkill {
  readonly name: string
  readonly description: string
  /** Reference file names under the skill's `references/` directory. */
  readonly references?: readonly string[]
}

/**
 * Catalog of the skills shipped with the worker. The prose bodies live as real markdown under
 * `./skills/<name>/` (SKILL.md + references/*.md) and are bundled into dist via the package's
 * `sixbBuild.assets`; only the name/description metadata lives here so {@link renderAgentSkillCatalog}
 * stays synchronous.
 */
const SIXB_AGENT_SKILLS: readonly AgentSkill[] = [
  {
    name: "sixb-query",
    description:
      "Use when discovering ontology, reading Sixb objects, filtering, sorting, paging, counting, faceting, traversing links, or expanding object query results.",
    references: ["query-api.md", "query-shapes.md", "predicates.md", "examples.md"],
  },
  {
    name: "sixb-telemetry",
    description:
      "Use when reading Sixb telemetry latest values or history for ontology telemetry properties.",
    references: ["telemetry-api.md"],
  },
  {
    name: "sixb-actions",
    description:
      "Use when requesting declared Sixb ontology actions as the preferred mutation path.",
    references: ["actions-api.md"],
  },
]

/**
 * Resolve the packaged skills directory. `import.meta.url` points at this module wherever it runs —
 * `src/` under the `bun` dev condition, `dist/` for a published build (where `sixbBuild.assets`
 * copies the tree) — so the same relative URL finds the bundled markdown in both layouts.
 */
const SKILLS_ROOT = new URL("./skills/", import.meta.url)

/**
 * Build the file records that install the agent skills into a sandbox, reading the packaged
 * markdown. Returns records targeting `<skillsDir>/<name>/SKILL.md` and
 * `<skillsDir>/<name>/references/<file>`, ready to hand to {@link Sandbox.writeFiles}.
 */
export async function buildAgentSkillFiles(
  skillsDir: string
): Promise<readonly SandboxFileRecord[]> {
  const records: SandboxFileRecord[] = []
  for (const skill of SIXB_AGENT_SKILLS) {
    const source = new URL(`${skill.name}/`, SKILLS_ROOT)
    records.push({
      path: join(skillsDir, skill.name, "SKILL.md"),
      contents: await readFile(new URL("SKILL.md", source), "utf-8"),
    })
    for (const reference of skill.references ?? []) {
      records.push({
        path: join(skillsDir, skill.name, "references", reference),
        contents: await readFile(new URL(`references/${reference}`, source), "utf-8"),
      })
    }
  }
  return records
}

export function renderAgentSkillCatalog(): string {
  return [
    "Sixb API access is available from the sandboxed bash tool through a per-run gateway URL.",
    "Agent Skills are installed under $SIXB_SKILLS_DIR.",
    "Message attachments, when present, are listed in $SIXB_ATTACHMENTS and materialized under $SIXB_ATTACHMENT_DIR when size limits allow.",
    "Write user-facing files you create under $SIXB_OUTPUT_DIR; files left there are attached to your final chat message when size limits allow.",
    "Use $SIXB_SKILLS_DIR and attachment/output env vars to reference file paths; do not hardcode sandbox directory paths.",
    "Before using a matching Sixb ontology API surface, read that skill's SKILL.md with bash/cat.",
    "Use live ontology and object APIs rather than guessing schema or relying on stale context.",
    "Do not add Authorization or Cookie headers. The gateway authenticates allowed requests.",
    "Operate through the ontology layer: object types, object reads/queries, telemetry reads, and declared actions.",
    "",
    "Available Agent Skills:",
    ...SIXB_AGENT_SKILLS.map(
      (skill) => `- ${skill.name}: ${skill.description} Path: $SIXB_SKILLS_DIR/${skill.name}`
    ),
  ].join("\n")
}
