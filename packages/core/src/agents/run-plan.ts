import { createSixbError } from "../errors/internal"
import type {
  LanguageModelCatalog,
  LanguageModelRef,
  LanguageModelTier,
  ModelCatalog,
} from "../models/catalog"
import type { LanguageModelDefinition } from "../models/definitions"
import type { PropertyClearance } from "../objects/property-clearance"
import type { OntologyDocsCatalog } from "../ontology/docs"
import { type RenderedOntologyDocs, renderOntologyDocs } from "../ontology/docs-markdown"
import type { SixbDefinitions } from "../runtime/definitions"
import type { Sixb } from "../runtime/sixb"
import type { AgentRunRecord } from "../storage/agents"
import { AgentMemoryError } from "./errors"
import type { AgentMemoryRepoName } from "./memory"
import type { AgentMemoryRepoView } from "./memory-execution"
import { type AgentToolSpec, agentToolSpec } from "./run-tools"
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
  /** The project tools the run offers, as the model is offered them. */
  readonly tools: readonly AgentToolSpec[]
  /** The models its `sixb` can call beside its own, as its prompt lists them. */
  readonly sandboxModels: readonly SandboxModel[]
  /** The requester's time zone and locale, when the run captured them. */
  readonly timeZone?: string
  readonly locale?: string
  /** Reference docs for the object types its requester can see, from their own view. */
  readonly ontologyDocs: RenderedOntologyDocs
  /** The models a turn can hand a child; a child spawns none. */
  readonly delegation?: AgentRunDelegation
}

/** The project's language models, as a turn chooses one for a child it spawns. */
export interface AgentRunDelegation {
  /** In catalog order: with tiers, light, standard then heavy. */
  readonly models: readonly AgentRunDelegationModel[]
  /** The project default, for a child spawned without a model. */
  readonly defaultModel: LanguageModelRef
  /** The tiers the project configures; empty when `models.language` is a list. */
  readonly tiers: readonly LanguageModelTier[]
}

export interface AgentRunDelegationModel extends LanguageModelRef {
  readonly tier?: LanguageModelTier
  /** As the model's binding configures it, never its provider's catalog. */
  readonly definition: LanguageModelDefinition
  readonly defaultReasoning?: AgentReasoning
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
export type AgentRunPlanDefinitions = Pick<
  SixbDefinitions,
  "agent" | "models" | "ontology" | "tools"
>

/** How a run's requester sees the project: through the run's SDK, with their clearance. */
export interface AgentRunView {
  readonly sixb: Pick<Sixb, "objects" | "actions">
  /** Marked properties the requester cannot read; absent when they read every property. */
  readonly propertyClearance?: PropertyClearance
}

/**
 * The plan of a conversation's turn or a child. A turn offers every project tool and skill, on the
 * model its admission froze, or the project default for a turn admitted before specs existed. A
 * child keeps the model and tools its parent chose when it spawned it.
 */
export function readAgentRunPlan(
  definitions: AgentRunPlanDefinitions,
  run: AgentRunRecord,
  view: AgentRunView
): AgentRunPlan {
  const { agent, models, tools } = definitions
  const shared = {
    ...(agent.instructions === undefined ? {} : { instructions: agent.instructions }),
    skills: agent.skills.list(),
    sandboxModels: listSandboxModels(models),
    ontologyDocs: renderAgentRunOntologyDocs({ ...view, catalog: agent.ontologyDocs }),
  }

  if (run.kind === "subagent") {
    const { model, reasoning, timeZone, locale } = run.spec
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
      tools: toolSpecs(definitions, run.spec.toolNames),
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
  const language = models?.language
  return Object.freeze({
    ...shared,
    model: { provider: entry.provider, modelId: entry.modelId },
    ...(language ? { delegation: readAgentRunDelegation(language) } : {}),
    tools: toolSpecs(
      definitions,
      tools.list().map((tool) => tool.name)
    ),
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

/** What a run reads of its memory: each repo its requester reads, now and as of a moment. */
export interface AgentRunMemory {
  /** Others take part in the conversation, so the project's memory alone is read. */
  readonly shared: boolean
  readonly repos: readonly {
    readonly latest: AgentMemoryRepoView
    readonly then: AgentMemoryRepoView
  }[]
}

/**
 * The repos a run's requester can read, each at its latest revision and as of `asOf`. A requester
 * without a repo of their own, such as a service account, reads the project's alone, and so does a
 * shared conversation: others read it, so it reaches no one's own memory.
 */
export async function readAgentRunMemory(
  sixb: Pick<Sixb, "agent">,
  input: { readonly shared: boolean; readonly asOf: Date }
): Promise<AgentRunMemory> {
  const names: readonly AgentMemoryRepoName[] = input.shared ? ["project"] : ["user", "project"]
  const repos = await Promise.all(
    names.map(async (repo) => {
      try {
        const [latest, then] = await Promise.all([
          sixb.agent.memory.get(repo),
          sixb.agent.memory.get(repo, { asOf: input.asOf }),
        ])
        return [{ latest, then }]
      } catch (error) {
        if (error instanceof AgentMemoryError && error.code === "not_allowed") return []
        throw error
      }
    })
  )
  return { shared: input.shared, repos: repos.flat() }
}

/** Requesters with the same view share rendered docs; a project has few distinct views. */
const renderedOntologyDocs = new WeakMap<OntologyDocsCatalog, Map<string, RenderedOntologyDocs>>()
const MAX_RENDERED_ONTOLOGY_VIEWS = 16

/** Reference docs for the object types a run's requester can see, from their own view. */
export function renderAgentRunOntologyDocs(input: {
  /** The run's SDK, bound as its requester. */
  readonly sixb: Pick<Sixb, "objects" | "actions">
  readonly catalog: OntologyDocsCatalog
  /** Marked properties the requester cannot read; absent when they read every property. */
  readonly propertyClearance?: PropertyClearance
}): RenderedOntologyDocs {
  const { sixb, propertyClearance, catalog } = input
  const objectTypes = sixb.objects.listTypes()
  const actionsByType = new Map(
    objectTypes.map((objectType) => [objectType.id, sixb.actions.listForType(objectType)])
  )
  // Definitions are immutable, so the visible types, restricted properties, and requestable actions
  // determine the output.
  const key = JSON.stringify(
    objectTypes.map((objectType) => [
      objectType.id,
      [...(propertyClearance?.hiddenProperties(objectType.id)?.ids ?? [])],
      actionsByType.get(objectType.id)?.map((action) => action.id),
    ])
  )
  const views = renderedOntologyDocs.get(catalog) ?? new Map<string, RenderedOntologyDocs>()
  renderedOntologyDocs.set(catalog, views)
  const cached = views.get(key)
  if (cached) return cached

  const rendered = renderOntologyDocs({
    catalog,
    objectTypes,
    valueTypesById: sixb.objects.getValueTypesById(),
    actionsFor: (objectType) => actionsByType.get(objectType.id) ?? [],
    ...(propertyClearance === undefined
      ? {}
      : {
          restrictedPropertyIds: (objectTypeId) =>
            propertyClearance.hiddenProperties(objectTypeId)?.ids,
        }),
  })
  views.set(key, rendered)
  const oldest = views.keys().next().value
  if (views.size > MAX_RENDERED_ONTOLOGY_VIEWS && oldest !== undefined) views.delete(oldest)
  return rendered
}

/** The project's language models, as a turn offers them to the children it spawns. */
export function readAgentRunDelegation(language: LanguageModelCatalog): AgentRunDelegation {
  return {
    models: language.list().map(
      ({ provider, modelId, tier, model }): AgentRunDelegationModel => ({
        provider,
        modelId,
        ...(tier === undefined ? {} : { tier }),
        definition: model.definition,
        ...(model.defaultReasoning === undefined
          ? {}
          : { defaultReasoning: model.defaultReasoning }),
      })
    ),
    defaultModel: { provider: language.default.provider, modelId: language.default.modelId },
    tiers: language.tiers,
  }
}

/** The specs of the project tools named, each as the model is offered it. */
function toolSpecs(
  definitions: AgentRunPlanDefinitions,
  names: readonly string[]
): readonly AgentToolSpec[] {
  const valueTypesById = definitions.ontology.getValueTypesById()
  return names.map((name) => {
    const definition = definitions.tools.getByName(name)
    if (!definition) {
      throw createSixbError(
        "agent.execution_failed",
        `[Sixb] Project tool '${name}' is not available.`,
        { details: { toolName: name } }
      )
    }
    return agentToolSpec(definition, valueTypesById)
  })
}
