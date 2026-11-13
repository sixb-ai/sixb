import { UnsupportedModelFeatureError } from "@sixb/core/models"
import type { AzureAIFoundryDeployment } from "./discovery"
import { PREFIX } from "./util"

/**
 * What a deployment runs, read from its model name. Project discovery reports no kind: an audio
 * or rerank deployment lists no capabilities, or `chat_completion`, like a language model.
 */
export type FoundryKind =
  | "language"
  | "embedding"
  | "decision"
  | "transcription"
  | "reranking"
  | "speech"
  | "image"

export const KIND_BINDINGS: Readonly<Record<FoundryKind, string>> = {
  language: "foundry() or foundry.chat()",
  embedding: "foundry.embedding()",
  decision: "foundry.decision()",
  transcription: "foundry.transcription()",
  reranking: "foundry.reranking()",
  speech: "foundry.speech()",
  image: "foundry.image()",
}

export function deploymentKind(deployment: AzureAIFoundryDeployment): FoundryKind {
  if (isEmbeddingDeployment(deployment)) return "embedding"
  if (isDecisionDeployment(deployment)) return "decision"
  if (isTranscriptionDeployment(deployment)) return "transcription"
  // Discovery reports `chat_completion: "true"` for Rerank v4.0; it is no chat model.
  if (/^cohere-rerank-/i.test(deployment.modelName)) return "reranking"
  // tts and tts-hd are speech models too, which foundry.speech() rejects with the reason.
  if (
    deployment.capabilities.audioSpeech === "true" ||
    /^(gpt-4o-mini-tts|tts|tts-hd)$/i.test(deployment.modelName)
  )
    return "speech"
  // FLUX.2 and DALL-E are image models too, which foundry.image() rejects with the reason.
  if (
    deployment.capabilities.imageGenerations === "true" ||
    /^(gpt-image-|flux[-.]|dall-e-)/i.test(deployment.modelName)
  )
    return "image"
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
      `${PREFIX} Deployment '${deploymentName}' runs ${deployment.modelName}, not ${article(kind)} ${kind} model. Use ${KIND_BINDINGS[actual]}.`
    )
  // A connection's deployment lives on another resource, which its record does not name.
  if (deployment.connectionName)
    throw new UnsupportedModelFeatureError(
      `${PREFIX} ${capitalize(article(kind))} ${kind} deployment from a project connection cannot be routed; use the owning resource's project URL and API key.`
    )
}

/** "an image", "a speech": the article a kind's name takes. */
export function article(kind: FoundryKind): string {
  return /^[aeiou]/.test(kind) ? "an" : "a"
}

function capitalize(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1)
}

function isEmbeddingDeployment(deployment: AzureAIFoundryDeployment): boolean {
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
