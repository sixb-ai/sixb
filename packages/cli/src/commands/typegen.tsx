import { generateProjectTypes } from "../lib/typegen"
import { renderStatic, TypegenView } from "../ui"

export interface TypegenOptions {
  entry?: string
}

export async function runTypegen(options: TypegenOptions = {}) {
  const result = await generateProjectTypes(options)
  await renderStatic(
    <TypegenView
      path={result.path}
      objectTypes={result.entries.length}
      skipped={result.skipped}
      written={result.written}
    />
  )
}
