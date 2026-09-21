import { getInvalidJsonValueReason, isPlainRecord } from "../json"
import { OntologyValidationError } from "../ontology/errors"
import type { OntologyRegistry } from "../ontology/registry"
import type { SandboxDefinition } from "../sandboxes/configuration"
import { normalizeParams } from "../shared/params/validation"
import type { AgentThreadSandbox } from "../storage/agents/types"
import { AgentRequestError } from "./errors"

export function normalizeSandboxBinding(
  definition: Pick<SandboxDefinition, "params"> | undefined,
  input: unknown,
  ontology: OntologyRegistry
): AgentThreadSandbox {
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
    const params = normalizeParams(ontology.getValueTypesById(), definition.params, input, {
      kind: "sandbox",
      id: "sandboxes",
      path: "sandbox",
    })
    if (getInvalidJsonValueReason(params)) {
      throw new OntologyValidationError("[Sixb] Sandbox params must normalize to JSON values.")
    }
    return params
  } catch (error) {
    throw new AgentRequestError(
      "invalid_sandbox_params",
      error instanceof OntologyValidationError
        ? error.message
        : "[Sixb] Sandbox params could not be normalized."
    )
  }
}
