import { type AzureAIFoundryOptions, createAzureAIFoundry as create } from "../src"

export type * from "../src"

// Protocol/discovery tests supply their own model facts and mock only inference/project HTTP.
export function createAzureAIFoundry(options: AzureAIFoundryOptions) {
  return create({ catalog: false, ...options })
}
