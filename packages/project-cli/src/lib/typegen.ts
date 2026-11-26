import { dirname, resolve } from "node:path"
import { generateOntologyTypeManifest } from "@sixb/core/internal/bootstrap"

export interface GenerateProjectTypesOptions {
  readonly entry?: string
}

export async function generateProjectTypes(options: GenerateProjectTypesOptions = {}) {
  const entry = resolve(options.entry ?? "sixb.config.ts")
  const projectRoot = dirname(entry)
  return generateOntologyTypeManifest({ projectRoot })
}
