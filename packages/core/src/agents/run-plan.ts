import { createSixbError } from "../errors/internal"
import type { LanguageModelRef, LanguageModelTier, ModelCatalog } from "../models/catalog"
import type { SixbDefinitions } from "../runtime/definitions"
import type { AgentRunRecord } from "../storage/agents"
import type { AgentSkillDefinition } from "./skills"
import type { AgentReasoning } from "./types"

// What a run is set up with, as plain data: the project sends it, and the runner's harness, which
// ships its own prompt, skills and tools, builds the run from it. A runner in the worker reads it
// in process; one on a computer gets the same answer over HTTP.

/** What a conversation's turn or a child is set up with. */
export interface AgentRunPlan {
  /** The model the run calls. */
  readonly model: LanguageModelRef
  /** The reasoning it asks for, frozen when the run was admitted. */
  readonly reasoning?: AgentReasoning
  /** The project's `SIXB.md`. */
  readonly instructions?: string
  /** The project's Agent Skills; the harness adds its own. */
  readonly skills: readonly AgentSkillDefinition[]
  /** The project tools the run offers, by name. */
  readonly toolNames: readonly string[]
  /** The models its `sixb` can call beside its own, as its prompt lists them. */
  readonly sandboxModels: readonly SandboxModel[]
  /** The requester's time zone and locale, when the run captured them. */
  readonly timeZone?: string
  readonly locale?: string
}

export type SandboxModelKind = "language" | "image" | "speech" | "transcription"

/** One model the agent reaches through `sixb models`, as its prompt describes it. */
export interface SandboxModel {
  readonly kind: SandboxModelKind
  readonly provider: string
  readonly modelId: string
  /** A language model's tier, when the project configures its language models by tier. */
  readonly tier?: LanguageModelTier
  /** A language model's display name. */
  readonly name?: string
  readonly description?: string
}

/** The definitions a run's plan is read from. */
export type AgentRunPlanDefinitions = Pick<SixbDefinitions, "agent" | "models" | "tools">

/**
 * The plan of a conversation's turn or a child. A turn offers every project tool and skill, on the
 * model its admission froze, or the project default for a turn admitted before specs existed. A
 * child keeps the model and tools its parent chose when it spawned it.
 */
export function readAgentRunPlan(
  definitions: AgentRunPlanDefinitions,
  run: AgentRunRecord
): AgentRunPlan {
  const { agent, models, tools } = definitions
  const shared = {
    ...(agent.instructions === undefined ? {} : { instructions: agent.instructions }),
    skills: agent.skills.list(),
    sandboxModels: listSandboxModels(models),
  }

  if (run.kind === "subagent") {
    const { model, reasoning, toolNames, timeZone, locale } = run.spec
    if (!models?.language?.getByRef(model)) {
      throw createSixbError(
        "agent.execution_failed",
        `[Sixb] Subagent run '${run.id}' cannot resolve language model '${model.provider}/${model.modelId}'.`,
        { details: { parentRunId: run.parentRunId, runId: run.id } }
      )
    }
    return Object.freeze({
      ...shared,
      model: { provider: model.provider, modelId: model.modelId },
      toolNames,
      ...(reasoning === undefined ? {} : { reasoning }),
      ...(timeZone === undefined ? {} : { timeZone }),
      ...(locale === undefined ? {} : { locale }),
    })
  }

  const spec = run.spec
  const ref = spec?.model ?? models?.language?.default
  const entry = ref ? models?.language?.getByRef(ref) : undefined
  if (!entry) {
    throw createSixbError(
      "agent.execution_failed",
      "[Sixb] The conversation's language model is not available in models.language."
    )
  }
  // Admission freezes the model's default reasoning into the spec; only runs admitted before
  // specs existed take today's default.
  const reasoning = spec ? spec.reasoning : entry.model.defaultReasoning
  return Object.freeze({
    ...shared,
    model: { provider: entry.provider, modelId: entry.modelId },
    toolNames: tools.list().map((tool) => tool.name),
    ...(reasoning === undefined ? {} : { reasoning }),
    ...(spec?.timeZone === undefined ? {} : { timeZone: spec.timeZone }),
    ...(spec?.locale === undefined ? {} : { locale: spec.locale }),
  })
}

/**
 * The project's models, with what each is for: its language models in catalog order, then each
 * media kind's, default first. Read from each model's configured definition, never its provider
 * catalog, so the prompt that lists them stays the same from turn to turn.
 */
export function listSandboxModels(models: ModelCatalog | undefined): readonly SandboxModel[] {
  const language = (models?.language?.list() ?? []).map((entry): SandboxModel => {
    const { name, description } = entry.model.definition
    return {
      kind: "language",
      provider: entry.provider,
      modelId: entry.modelId,
      ...(entry.tier === undefined ? {} : { tier: entry.tier }),
      ...(name ? { name } : {}),
      ...(description ? { description } : {}),
    }
  })
  const media = (
    [
      ["image", models?.image],
      ["speech", models?.audio?.speech],
      ["transcription", models?.audio?.transcription],
    ] as const
  ).flatMap(([kind, catalog]) =>
    (catalog?.list() ?? []).map((entry): SandboxModel => {
      const description = entry.model.definition.description
      return {
        kind,
        provider: entry.provider,
        modelId: entry.modelId,
        ...(description ? { description } : {}),
      }
    })
  )
  return [...language, ...media]
}
