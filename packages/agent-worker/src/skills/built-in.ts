/// <reference path="./text-assets.d.ts" />
import type { AgentSkillDefinition } from "@sixb/core"
import documentGuide from "./sixb-artifacts/document.md" with { type: "text" }
import incidentReport from "./sixb-artifacts/examples/document/incident-report/document.md" with {
  type: "text",
}
import operationsReview from "./sixb-artifacts/examples/document/operations-review/document.md" with {
  type: "text",
}
import restorationsFigure from "./sixb-artifacts/examples/document/operations-review/figures/restorations.svg" with {
  type: "text",
}
import fileGuide from "./sixb-artifacts/file.md" with { type: "text" }
import skillMarkdown from "./sixb-artifacts/SKILL.md" with { type: "text" }

/**
 * Skills the worker ships, in every conversation's catalog. They describe formats the publisher
 * validates and the app renders, so they change with them. A project skill with the same name
 * replaces the built-in one.
 */
export const BUILT_IN_SKILLS: readonly AgentSkillDefinition[] = Object.freeze([
  builtInSkill(skillMarkdown, {
    "document.md": documentGuide,
    "file.md": fileGuide,
    "examples/document/operations-review/document.md": operationsReview,
    "examples/document/operations-review/figures/restorations.svg": restorationsFigure,
    "examples/document/incident-report/document.md": incidentReport,
  }),
])

/** The project's skills, then each built-in skill the project does not replace. */
export function withBuiltInSkills(
  projectSkills: readonly AgentSkillDefinition[]
): readonly AgentSkillDefinition[] {
  const names = new Set(projectSkills.map((skill) => skill.name))
  return Object.freeze([
    ...projectSkills,
    ...BUILT_IN_SKILLS.filter((skill) => !names.has(skill.name)),
  ])
}

function builtInSkill(skill: string, files: Record<string, string>): AgentSkillDefinition {
  const frontmatter = /^---\n([\s\S]*?)\n---\n/.exec(skill)?.[1]
  const metadata: unknown = frontmatter === undefined ? null : Bun.YAML.parse(frontmatter)
  if (
    typeof metadata !== "object" ||
    metadata === null ||
    !("name" in metadata) ||
    typeof metadata.name !== "string" ||
    !("description" in metadata) ||
    typeof metadata.description !== "string"
  ) {
    throw new Error("[SixbAgentWorker] A built-in skill's SKILL.md needs a name and a description.")
  }
  return Object.freeze({
    name: metadata.name,
    description: metadata.description,
    files: Object.freeze([
      { path: "SKILL.md", contents: skill },
      ...Object.entries(files).map(([path, contents]) => ({ path, contents })),
    ]),
  })
}
