import { getInvalidJsonValueReason, isPlainRecord } from "../json"
import { OntologyValidationError } from "../ontology/errors"
import type { OntologyRegistry } from "../ontology/registry"
import { type SandboxDefinition, sandboxBindingParams } from "../sandboxes/configuration"
import { SandboxError } from "../sandboxes/errors"
import { assertBranchName, isProjectBranchBinding } from "../sandboxes/source"
import { normalizeParams } from "../shared/params/validation"
import type { AgentThreadSandboxParams } from "../storage/agents/types"
import { AgentRequestError } from "./errors"

export function normalizeSandboxBinding(
  definition: Pick<SandboxDefinition, "params" | "source"> | undefined,
  input: unknown,
  ontology: OntologyRegistry
): AgentThreadSandboxParams {
  if (!definition) {
    throw new AgentRequestError(
      "sandbox_not_configured",
      "[Sixb] This sandbox provider has no compatible thread configuration."
    )
  }
  if (!isPlainRecord(input)) {
    throw new AgentRequestError(
      "invalid_sandbox_params",
      "[Sixb] sandbox must be an object containing the declared parameter values."
    )
  }
  try {
    const params = normalizeParams(
      ontology.getValueTypesById(),
      sandboxBindingParams(definition, input),
      input,
      {
        kind: "sandbox",
        id: "sandboxes",
        path: "sandbox",
      }
    )
    if (getInvalidJsonValueReason(params)) {
      throw new OntologyValidationError("[Sixb] Sandbox params must normalize to JSON values.")
    }
    if (definition.source && isProjectBranchBinding(params)) assertBranchName(params.branch)
    return params
  } catch (error) {
    throw new AgentRequestError(
      "invalid_sandbox_params",
      error instanceof OntologyValidationError || error instanceof SandboxError
        ? error.message
        : "[Sixb] Sandbox params could not be normalized."
    )
  }
}
