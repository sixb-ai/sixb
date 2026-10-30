import type { LanguageModelTier } from "@sixb/core"

/**
 * One language model on one line, as the prompt lists the models the Agent can ask or delegate
 * to: under its tier, else as a list item, then its name, what the caller adds about it, and its
 * description.
 */
export function renderModelLine(input: {
  readonly tier?: LanguageModelTier
  /** How the caller names the model, such as the reference a command takes. */
  readonly reference: string
  readonly name?: string
  /** Written as given between the name and the description, such as `(default; tools)`. */
  readonly details?: string
  readonly description?: string
}): string {
  const name = input.name === undefined ? "" : ` ${oneLine(input.name)}`
  const details = input.details === undefined ? "" : ` ${input.details}`
  const description = input.description === undefined ? "" : `: ${oneLine(input.description)}`
  const line = `${input.reference}${name}${details}${description}`

  return input.tier === undefined ? `- ${line}` : `${input.tier.padEnd(10)}${line}`
}

// A provider's catalog text may span lines; each model keeps to one.
function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim()
}
