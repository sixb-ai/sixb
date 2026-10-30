/// <reference path="./text-assets.d.ts" />
import type { AgentSkillDefinition } from "@sixb/core"
import canvasGuide from "./sixb-artifacts/canvas.md" with { type: "text" }
import documentGuide from "./sixb-artifacts/document.md" with { type: "text" }
import onboardingFirstJob from "./sixb-artifacts/examples/canvas/onboarding-flow/boards/first-job.html" with {
  type: "text",
}
import onboardingRegion from "./sixb-artifacts/examples/canvas/onboarding-flow/boards/region.html" with {
  type: "text",
}
import onboardingShared from "./sixb-artifacts/examples/canvas/onboarding-flow/boards/shared.css" with {
  type: "text",
}
import onboardingWelcome from "./sixb-artifacts/examples/canvas/onboarding-flow/boards/welcome.html" with {
  type: "text",
}
import onboardingCanvas from "./sixb-artifacts/examples/canvas/onboarding-flow/canvas.json" with {
  type: "text",
}
import retroCanvas from "./sixb-artifacts/examples/canvas/retro/canvas.json" with { type: "text" }
import incidentReport from "./sixb-artifacts/examples/document/incident-report/document.md" with {
  type: "text",
}
import operationsReview from "./sixb-artifacts/examples/document/operations-review/document.md" with {
  type: "text",
}
import restorationsFigure from "./sixb-artifacts/examples/document/operations-review/figures/restorations.svg" with {
  type: "text",
}
import collectionsDeskPage from "./sixb-artifacts/examples/page/collections-desk/index.html" with {
  type: "text",
}
import collectionsDeskQuery from "./sixb-artifacts/examples/page/collections-desk/queries/overdue.json" with {
  type: "text",
}
import dispatchBoardData from "./sixb-artifacts/examples/page/dispatch-board/data/dispatch.json" with {
  type: "text",
}
import dispatchBoardPage from "./sixb-artifacts/examples/page/dispatch-board/index.html" with {
  type: "text",
}
import fleetPlannerData from "./sixb-artifacts/examples/page/fleet-planner/data/plan.json" with {
  type: "text",
}
import fleetPlannerPage from "./sixb-artifacts/examples/page/fleet-planner/index.html" with {
  type: "text",
}
import serviceExplorerData from "./sixb-artifacts/examples/page/service-explorer/data/service.json" with {
  type: "text",
}
import serviceExplorerPage from "./sixb-artifacts/examples/page/service-explorer/index.html" with {
  type: "text",
}
import overdueQuery from "./sixb-artifacts/examples/sheet/overdue-invoices/queries/overdue.json" with {
  type: "text",
}
import overdueWorkbook from "./sixb-artifacts/examples/sheet/overdue-invoices/workbook.json" with {
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
import pageGuide from "./sixb-artifacts/page.md" with { type: "text" }
import queriesGuide from "./sixb-artifacts/queries.md" with { type: "text" }
import referencesGuide from "./sixb-artifacts/references.md" with { type: "text" }
import skillMarkdown from "./sixb-artifacts/SKILL.md" with { type: "text" }
import sheetGuide from "./sixb-artifacts/sheet.md" with { type: "text" }
import slidesGuide from "./sixb-artifacts/slides.md" with { type: "text" }
import memorySkillMarkdown from "./sixb-memory/SKILL.md" with { type: "text" }

/**
 * Skills the worker ships, in every conversation's catalog. They describe formats the publisher
 * validates and the app renders, so they change with them. Their names start with `sixb-`, which
 * skill discovery refuses for a project's skills, so none collides with one.
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
    "examples/sheet/overdue-invoices/workbook.json": text(overdueWorkbook),
    "examples/sheet/overdue-invoices/queries/overdue.json": text(overdueQuery),
    "queries.md": queriesGuide,
    "page.md": pageGuide,
    "examples/page/fleet-planner/index.html": text(fleetPlannerPage),
    "examples/page/fleet-planner/data/plan.json": text(fleetPlannerData),
    "examples/page/service-explorer/index.html": text(serviceExplorerPage),
    "examples/page/service-explorer/data/service.json": text(serviceExplorerData),
    "examples/page/dispatch-board/index.html": text(dispatchBoardPage),
    "examples/page/dispatch-board/data/dispatch.json": text(dispatchBoardData),
    "examples/page/collections-desk/index.html": text(collectionsDeskPage),
    "examples/page/collections-desk/queries/overdue.json": text(collectionsDeskQuery),
    "canvas.md": canvasGuide,
    "examples/canvas/onboarding-flow/canvas.json": text(onboardingCanvas),
    "examples/canvas/onboarding-flow/boards/welcome.html": text(onboardingWelcome),
    "examples/canvas/onboarding-flow/boards/region.html": text(onboardingRegion),
    "examples/canvas/onboarding-flow/boards/first-job.html": text(onboardingFirstJob),
    "examples/canvas/onboarding-flow/boards/shared.css": text(onboardingShared),
    "examples/canvas/retro/canvas.json": text(retroCanvas),
  }),
])

/**
 * How to write and save the Agent's memory. Installed with the memory, outside the catalog: the
 * memory section of the prompt names it, so runs without memory never see it.
 */
export const MEMORY_SKILL: AgentSkillDefinition = builtInSkill(memorySkillMarkdown, {})

/** The project's skills, then the built-in ones. */
export function withBuiltInSkills(
  projectSkills: readonly AgentSkillDefinition[]
): readonly AgentSkillDefinition[] {
  return Object.freeze([...projectSkills, ...BUILT_IN_SKILLS])
}

/**
 * A JSON or HTML file imported as text: TypeScript types the import as the parsed value or Bun's
 * HTML bundle, which it is not.
 */
function text(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("[SixbAgent] A built-in skill's file must be imported as text.")
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
    throw new Error("[SixbAgent] A built-in skill's SKILL.md needs a name and a description.")
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
