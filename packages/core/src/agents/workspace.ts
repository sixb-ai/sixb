import { getInvalidJsonValueReason, isPlainRecord } from "../json"
import { OntologyValidationError } from "../ontology/errors"
import type { OntologyRegistry } from "../ontology/registry"
import { assertValidSchema } from "../ontology/validation/definition"
import type { Sixb } from "../runtime/sixb"
import type { SandboxNetworkPolicy } from "../sandboxes/sandbox"
import type { InferParams, ParamsConfig } from "../shared/params/types"
import { coerceParamsToTyped, normalizeParams } from "../shared/params/validation"
import type { AgentThreadWorkspace } from "../storage/agents/types"
import { AgentDefinitionError, AgentRequestError } from "./errors"

/** Host-side recipe. Environment values are guest-readable, never a Git credential channel. */
export interface ResolvedAgentWorkspace {
  readonly source: {
    readonly type: "git"
    readonly url: string
    readonly revision?: string
    readonly access?: "read" | "write"
  }
  readonly setup?: readonly string[]
  /** Additional destinations beyond the Sixb API and repository. Omitted/none adds none;
   * restricted adds declared origins; all explicitly enables unrestricted network access.
   * Resolved and applied afresh on every run, including resume.
   */
  readonly network?: SandboxNetworkPolicy
  readonly env?: Readonly<Record<string, string>>
}

export interface AgentWorkspaceResolveContext<TParams = Record<string, unknown>> {
  readonly params: TParams
  /** Bound to the current execution; a stored binding is not authorization. */
  readonly sixb: Sixb
}

// The recipe both declares and consumes this schema: keep it invariant instead of asking
// TypeScript to compare the recursive ontology inference through callback variance.
export interface AgentWorkspaceConfig<in out TParams extends ParamsConfig = ParamsConfig> {
  readonly params: TParams
  readonly resolve: (
    context: AgentWorkspaceResolveContext<InferParams<NoInfer<TParams>>>
  ) => ResolvedAgentWorkspace | Promise<ResolvedAgentWorkspace>
}

/** Registered project recipe; only thread params cross the durable boundary. */
export interface AgentWorkspaceDefinition {
  readonly params: ParamsConfig
  readonly resolve: (context: AgentWorkspaceResolveContext) => Promise<ResolvedAgentWorkspace>
}

export function createAgentWorkspaceDefinition<TParams extends ParamsConfig>(
  config: AgentWorkspaceConfig<TParams>,
  ontology: OntologyRegistry
): AgentWorkspaceDefinition {
  if (
    !isPlainRecord(config) ||
    !isPlainRecord(config.params) ||
    typeof config.resolve !== "function"
  ) {
    throw new AgentDefinitionError("[Sixb] agentWorkspace requires params and a resolve function.")
  }
  for (const key of Object.keys(config)) {
    if (key !== "params" && key !== "resolve") {
      throw new AgentDefinitionError("[Sixb] Unknown agentWorkspace configuration field.")
    }
  }
  const invalid = (path: string) =>
    new AgentDefinitionError(
      `[Sixb] ${path} must be a valid parameter declaration; use param(schema).`
    )
  for (const [id, value] of Object.entries(config.params)) {
    const path = `agentWorkspace.params.${id}`
    if (!id.trim() || !isPlainRecord(value)) throw invalid(path)
    for (const key of Object.keys(value)) {
      if (!["schema", "required", "nullable", "description", "semanticType"].includes(key)) {
        throw invalid(path)
      }
    }
    if (
      (value.required !== undefined && typeof value.required !== "boolean") ||
      (value.nullable !== undefined && typeof value.nullable !== "boolean") ||
      (value.description !== undefined && typeof value.description !== "string") ||
      (value.semanticType !== undefined && typeof value.semanticType !== "string")
    )
      throw invalid(path)
    const schema: unknown = value.schema
    if (isPlainRecord(schema) && schema.type === "objectRef") {
      if (
        typeof schema.objectTypeId !== "string" ||
        !ontology.getObjectTypesById().has(schema.objectTypeId)
      ) {
        throw invalid(path)
      }
    } else {
      assertValidSchema(schema, `${path}.schema`, invalid)
    }
  }
  const params = structuredClone(config.params)
  // Capture the function too: later mutation of application config must not change this host.
  // Erase inference only after capturing its schema; every invocation validates and coerces below.
  const resolve = config.resolve as AgentWorkspaceConfig["resolve"]
  deepFreeze(params)
  return Object.freeze({
    params,
    resolve: async ({ params: input, sixb }: AgentWorkspaceResolveContext) => {
      const binding = normalizeAgentWorkspaceBinding({ params }, { params: input }, ontology)
      const typed = coerceParamsToTyped(params, binding.params, ontology.getValueTypesById())
      return resolve({ params: typed, sixb })
    },
  })
}

export function normalizeAgentWorkspaceBinding(
  definition: Pick<AgentWorkspaceDefinition, "params"> | undefined,
  input: unknown,
  ontology: OntologyRegistry
): AgentThreadWorkspace {
  if (!definition) {
    throw new AgentRequestError(
      "workspace_not_configured",
      "[Sixb] This project has no agentWorkspace configuration."
    )
  }
  if (
    !isPlainRecord(input) ||
    Object.keys(input).some((key) => key !== "params") ||
    !isPlainRecord(input.params)
  ) {
    throw new AgentRequestError(
      "invalid_workspace_params",
      "[Sixb] workspace must contain only a params object."
    )
  }
  try {
    const params = normalizeParams(ontology.getValueTypesById(), definition.params, input.params, {
      kind: "workspace",
      id: "agentWorkspace",
      path: "workspace.params",
    })
    if (getInvalidJsonValueReason(params)) {
      throw new OntologyValidationError("[Sixb] Workspace params must normalize to JSON values.")
    }
    return { params }
  } catch (error) {
    throw new AgentRequestError(
      "invalid_workspace_params",
      error instanceof OntologyValidationError
        ? error.message
        : "[Sixb] Workspace params could not be normalized."
    )
  }
}

function deepFreeze(value: object, seen = new Set<object>()): void {
  if (seen.has(value)) return
  seen.add(value)
  for (const child of Object.values(value)) {
    if (child !== null && typeof child === "object") deepFreeze(child, seen)
  }
  Object.freeze(value)
}
