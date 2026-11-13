import { UnsupportedModelFeatureError } from "@sixb/core/models"
import type { AzureAIFoundryDeployment } from "./discovery"
import { PREFIX } from "./util"

/**
 * What a deployment runs, read from its model name. Project discovery reports no kind: an audio
 * or rerank deployment lists no capabilities, or `chat_completion`, like a language model.
 */
export type FoundryKind = "language" | "embedding" | "decision" | "transcription" | "reranking"

export const KIND_BINDINGS: Readonly<Record<FoundryKind, string>> = {
  language: "foundry() or foundry.chat()",
  embedding: "foundry.embedding()",
  decision: "foundry.decision()",
  transcription: "foundry.transcription()",
  reranking: "foundry.reranking()",
}

export function deploymentKind(deployment: AzureAIFoundryDeployment): FoundryKind {
  if (isEmbeddingDeployment(deployment)) return "embedding"
  if (isDecisionDeployment(deployment)) return "decision"
  if (isTranscriptionDeployment(deployment)) return "transcription"
  // Discovery reports `chat_completion: "true"` for Rerank v4.0; it is no chat model.
  if (/^cohere-rerank-/i.test(deployment.modelName)) return "reranking"
  return "language"
}

/** Reject a deployment of another kind, naming the binding that serves it. */
export function assertDeploymentKind(
  deployment: AzureAIFoundryDeployment,
  deploymentName: string,
  kind: Exclude<FoundryKind, "language">
): void {
  const actual = deploymentKind(deployment)
  if (actual !== kind)
    throw new UnsupportedModelFeatureError(
      `${PREFIX} Deployment '${deploymentName}' runs ${deployment.modelName}, not a ${kind} model. Use ${KIND_BINDINGS[actual]}.`
    )
  // A connection's deployment lives on another resource, which its record does not name.
  if (deployment.connectionName)
    throw new UnsupportedModelFeatureError(
      `${PREFIX} A ${kind} deployment from a project connection cannot be routed; use the owning resource's project URL and API key.`
    )
}

export function isEmbeddingDeployment(deployment: AzureAIFoundryDeployment): boolean {
  return (
    deployment.capabilities.embeddings === "true" ||
    deployment.capabilities.embedding === "true" ||
    /^(text-embedding-|cohere-embed)/i.test(deployment.modelName)
  )
}

/** The Foundry catalog's decision models; project discovery reports no `decision` flag. */
function isDecisionDeployment(deployment: AzureAIFoundryDeployment): boolean {
  return (
    deployment.capabilities.decision === "true" ||
    /^microsoft-decision-/i.test(deployment.modelName)
  )
}

/** File transcription models; realtime-only ones such as gpt-live-transcribe are not. */
function isTranscriptionDeployment(deployment: AzureAIFoundryDeployment): boolean {
  return (
    deployment.capabilities.audioTranscriptions === "true" ||
    /^(whisper|gpt-4o-transcribe|gpt-4o-mini-transcribe|gpt-transcribe)(-|$)/i.test(
      deployment.modelName
    )
  )
}
