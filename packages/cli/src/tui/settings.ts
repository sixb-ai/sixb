import { readFile, writeFile } from "node:fs/promises"
import { type as osType } from "node:os"
import { dirname, join } from "node:path"
import type { ListModelsResponses } from "@sixb/client"
import { resolveConfigPath } from "../lib/profiles"

export type ApprovalMode = "manual" | "accept-edits" | "auto"
export type Place = "computer" | "cloud"
export type LanguageModel = ListModelsResponses[200]["language"][number]
export type ReasoningLevel = LanguageModel["reasoningLevels"][number]

/** What the next message is sent with. Remembered between sessions, per computer. */
export interface Settings {
  /** Where a new conversation runs; a conversation keeps where it started. */
  readonly place: Place
  /** The mode a new conversation starts in; in a conversation, the thread's applies. */
  readonly approvalMode: ApprovalMode
  /** A model the person picked; absent follows the project: Auto with tiers, else its default. */
  readonly model?: { readonly provider: string; readonly modelId: string }
  readonly reasoning?: ReasoningLevel
}

export const DEFAULT_SETTINGS: Settings = { place: "computer", approvalMode: "manual" }

export const APPROVAL_MODES: readonly {
  readonly mode: ApprovalMode
  readonly label: string
  readonly description: string
}[] = [
  {
    mode: "manual",
    label: "Ask first",
    description: "Checks with you before each action or workflow.",
  },
  {
    mode: "accept-edits",
    label: "Allow edits",
    description:
      "Changes your data on its own. Asks before reaching other systems or starting workflows.",
  },
  {
    mode: "auto",
    label: "Full access",
    description: "Runs every action and workflow without asking.",
  },
]

export function approvalLabel(mode: ApprovalMode): string {
  return APPROVAL_MODES.find((entry) => entry.mode === mode)?.label ?? mode
}

/** What this computer is called where the person picks where a conversation runs. */
export function computerName(): string {
  return osType() === "Darwin" ? "This Mac" : "This computer"
}

export function placeLabel(place: Place): string {
  return place === "computer" ? computerName() : "Cloud"
}

const SETTINGS_FILE = () => join(dirname(resolveConfigPath()), "tui.json")

export async function loadSettings(): Promise<Settings> {
  try {
    const stored = JSON.parse(await readFile(SETTINGS_FILE(), "utf8")) as Partial<Settings>
    return {
      place: stored.place === "cloud" ? "cloud" : "computer",
      approvalMode: APPROVAL_MODES.some((entry) => entry.mode === stored.approvalMode)
        ? (stored.approvalMode as ApprovalMode)
        : DEFAULT_SETTINGS.approvalMode,
      ...(stored.model?.provider && stored.model.modelId ? { model: stored.model } : {}),
      ...(stored.reasoning ? { reasoning: stored.reasoning } : {}),
    }
  } catch {
    return DEFAULT_SETTINGS
  }
}

export async function saveSettings(settings: Settings): Promise<void> {
  await writeFile(SETTINGS_FILE(), `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 }).catch(
    () => {}
  )
}

/** The model the next message runs on, as the composer names it. */
export function modelLabel(
  models: readonly LanguageModel[],
  settings: Settings
): { readonly name: string; readonly reasoning?: string } {
  const chosen = settings.model
    ? models.find(
        (model) =>
          model.provider === settings.model?.provider && model.modelId === settings.model.modelId
      )
    : undefined
  const tiers = models.some((model) => model.tier !== undefined)
  const model =
    chosen ?? (tiers ? undefined : (models.find((entry) => entry.isDefault) ?? models[0]))
  const reasoning =
    settings.reasoning && model?.reasoningLevels.includes(settings.reasoning)
      ? settings.reasoning
      : undefined
  return { name: model?.name ?? "Auto", ...(reasoning ? { reasoning } : {}) }
}

/** What a message asks the server for: only what the person chose. */
export function messageSelection(
  models: readonly LanguageModel[],
  settings: Settings
): { readonly model?: { provider: string; modelId: string }; readonly reasoning?: ReasoningLevel } {
  const chosen = settings.model
    ? models.find(
        (model) =>
          model.provider === settings.model?.provider && model.modelId === settings.model.modelId
      )
    : undefined
  const tiers = models.some((model) => model.tier !== undefined)
  const reasoningModel = chosen ?? (tiers ? undefined : models.find((entry) => entry.isDefault))
  const reasoning =
    settings.reasoning && reasoningModel?.reasoningLevels.includes(settings.reasoning)
      ? settings.reasoning
      : undefined
  return {
    ...(chosen ? { model: { provider: chosen.provider, modelId: chosen.modelId } } : {}),
    ...(reasoning ? { reasoning } : {}),
  }
}
