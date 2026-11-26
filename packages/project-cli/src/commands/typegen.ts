import { generateProjectTypes } from "../lib/typegen"
import { renderStatic, typegenView, withTask } from "../ui"

export interface TypegenOptions {
  entry?: string
}

export async function runTypegen(options: TypegenOptions = {}) {
  const result = await withTask("typegen", "Generating types", () => generateProjectTypes(options))
  await renderStatic(
    typegenView({
      path: result.path,
      objectTypes: result.entries.length,
      skipped: result.skipped,
      written: result.written,
    })
  )
}
