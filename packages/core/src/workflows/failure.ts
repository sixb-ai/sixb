import { withFailureMessage } from "../errors/failure-message"
import { createSixbError, isSixbError, summarizeErrorMessage } from "../errors/internal"
import {
  ModelProviderError,
  StructuredOutputError,
  UnsupportedModelFeatureError,
} from "../models/errors"

interface WorkflowNodeFailureIdentityBase {
  readonly workflowId: string
  readonly workflowRunId: string
  readonly nodeId: string
  readonly nodeRunId?: string
  readonly failurePhase?: "output-preflight" | "agent-loop" | "structured-finalizer"
  readonly modelId?: string
}

export interface WorkflowNodeFailureIdentity extends WorkflowNodeFailureIdentityBase {
  readonly child:
    | { readonly type: "step"; readonly stepId: string }
    | {
        readonly type: "action"
        readonly actionId: string
        readonly actionRunId?: string
      }
    | { readonly type: "agent"; readonly agentStepId: string }
    | { readonly type: "intervention"; readonly interventionId: string }
}

/** Translate a node-local failure into the workflow primitive's durable vocabulary. */
export function createWorkflowNodeFailure(error: unknown, identity: WorkflowNodeFailureIdentity) {
  const modelDetails = safeModelFailureDetails(error)
  const failure = createSixbError(
    "workflow.node_failed",
    summarizeErrorMessage(error, "Workflow node execution failed."),
    {
      cause: error,
      details: {
        ...workflowNodeFailureDetails(identity),
        ...modelDetails,
      },
    }
  )
  return modelDetails.modelFailure
    ? withFailureMessage(failure, modelDetails.modelFailure.message)
    : failure
}

/** Only controlled diagnostics cross the durable boundary; provider messages/output stay private. */
function safeModelFailureDetails(error: unknown): {
  modelFailure?: { source: string; reason: string; message: string; status?: number }
} {
  if (error instanceof UnsupportedModelFeatureError) {
    const reason = error.reason ?? "unsupported-feature"
    const messages = {
      "unsupported-feature":
        "The adapter cannot support a requested model feature. Check provider configuration.",
      "unsupported-model":
        "The model is configured without structured-output support. Choose a supported model.",
      "unsupported-schema":
        "The output schema is incompatible with the adapter. Use valid JSON Schema types, require every property, and disallow additional properties.",
    }
    return { modelFailure: { source: "adapter", reason, message: messages[reason] } }
  }
  if (error instanceof ModelProviderError) {
    // Interpret only known machine codes, never provider prose (which can echo private inputs).
    const schemaRejected = error.code === "invalid_json_schema" || error.code === "invalid_schema"
    const modelRejected = error.code === "model_not_supported" || error.code === "unsupported_model"
    return {
      modelFailure: {
        source: "provider",
        reason: schemaRejected
          ? "unsupported-schema"
          : modelRejected
            ? "unsupported-model"
            : "provider-rejection",
        message: schemaRejected
          ? "The model endpoint rejected the supplied schema. Check the routed provider's supported JSON Schema subset."
          : modelRejected
            ? "The model endpoint does not support the requested model configuration. Choose a supported model or route."
            : "The model endpoint rejected the request or failed its response. Check provider diagnostics for model, schema, authentication, or availability errors.",
        ...(error.status === undefined ? {} : { status: error.status }),
      },
    }
  }
  if (error instanceof StructuredOutputError) {
    return {
      modelFailure: {
        source: "validation",
        reason: "invalid-output",
        message:
          "The model response did not complete with valid output matching the workflow schema.",
      },
    }
  }
  return {}
}

/** Recover the native child error for direct callers and error-monitoring integrations. */
export function unwrapWorkflowNodeFailure(error: unknown): unknown {
  return isSixbError(error) && error.code === "workflow.node_failed" && error.cause !== undefined
    ? error.cause
    : error
}

function workflowNodeFailureDetails(identity: WorkflowNodeFailureIdentity) {
  const base = {
    workflowId: identity.workflowId,
    workflowRunId: identity.workflowRunId,
    nodeId: identity.nodeId,
    ...(identity.nodeRunId ? { nodeRunId: identity.nodeRunId } : {}),
    ...(identity.failurePhase ? { failurePhase: identity.failurePhase } : {}),
    ...(identity.modelId ? { modelId: identity.modelId } : {}),
  }

  switch (identity.child.type) {
    case "step":
      return { ...base, stepId: identity.child.stepId }
    case "action":
      return {
        ...base,
        actionId: identity.child.actionId,
        ...(identity.child.actionRunId ? { actionRunId: identity.child.actionRunId } : {}),
      }
    case "agent":
      return { ...base, agentStepId: identity.child.agentStepId }
    case "intervention":
      return { ...base, interventionId: identity.child.interventionId }
  }
}
