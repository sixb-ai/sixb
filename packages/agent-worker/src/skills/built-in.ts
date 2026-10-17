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
import partsInventory from "./sixb-artifacts/examples/sheet/parts-inventory/sheets/Inventory.csv" with {
  type: "text",
}
import partsSpend from "./sixb-artifacts/examples/sheet/parts-inventory/sheets/Spend.csv" with {
  type: "text",
}
import partsWorkbook from "./sixb-artifacts/examples/sheet/parts-inventory/workbook.json" with {
  type: "text",
}
import serviceQuarters from "./sixb-artifacts/examples/sheet/service-metrics/sheets/Quarters.csv" with {
  type: "text",
}
import serviceRegions from "./sixb-artifacts/examples/sheet/service-metrics/sheets/Regions.csv" with {
  type: "text",
}
import serviceWorkbook from "./sixb-artifacts/examples/sheet/service-metrics/workbook.json" with {
  type: "text",
}
import launchPlanDeck from "./sixb-artifacts/examples/slides/launch-plan/index.html" with {
  type: "text",
}
import q3ReviewDeck from "./sixb-artifacts/examples/slides/q3-review/index.html" with {
  type: "text",
}
import fileGuide from "./sixb-artifacts/file.md" with { type: "text" }
import referencesGuide from "./sixb-artifacts/references.md" with { type: "text" }
import skillMarkdown from "./sixb-artifacts/SKILL.md" with { type: "text" }
import sheetGuide from "./sixb-artifacts/sheet.md" with { type: "text" }
import slidesGuide from "./sixb-artifacts/slides.md" with { type: "text" }

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
    "sheet.md": sheetGuide,
    "references.md": referencesGuide,
    "slides.md": slidesGuide,
    "examples/slides/q3-review/index.html": text(q3ReviewDeck),
    "examples/slides/launch-plan/index.html": text(launchPlanDeck),
    "examples/sheet/service-metrics/workbook.json": text(serviceWorkbook),
    "examples/sheet/service-metrics/sheets/Quarters.csv": serviceQuarters,
    "examples/sheet/service-metrics/sheets/Regions.csv": serviceRegions,
    "examples/sheet/parts-inventory/workbook.json": text(partsWorkbook),
    "examples/sheet/parts-inventory/sheets/Inventory.csv": partsInventory,
    "examples/sheet/parts-inventory/sheets/Spend.csv": partsSpend,
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

/**
 * A JSON or HTML file imported as text: TypeScript types the import as the parsed value or Bun's
 * HTML bundle, which it is not.
 */
function text(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("[SixbAgentWorker] A built-in skill's file must be imported as text.")
  }
  return value
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
