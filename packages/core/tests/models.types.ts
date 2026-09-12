import type {
  LanguageModelCatalog,
  LanguageModelEntry,
  LanguageModelRef,
  ModelCatalogInput,
  ModelsRuntime,
} from "../src"

declare const input: ModelCatalogInput
declare const catalog: LanguageModelCatalog

const ref: LanguageModelRef = {
  provider: input.language[0]?.providerId ?? "vercel-ai-gateway",
  modelId: input.language[0]?.modelId ?? "openai/gpt-5.4",
}
const entry: LanguageModelEntry | null = catalog.getByRef(ref)
const listed: readonly LanguageModelEntry[] = catalog.list()
const defaultEntry: LanguageModelEntry = catalog.default

// @ts-expect-error model references are structured, never user-authored string aliases
catalog.getByRef("gateway/openai/gpt-5.4")

void entry
void listed
void defaultEntry

declare const models: ModelsRuntime
const text = await models.language.generate({ prompt: "Summarize" })
const textOutput: string = text.output
const structured = await models.language.generate({
  prompt: "Extract",
  output: { title: "string", count: "integer", date: "date", amount: "decimal" },
})
const structuredOutput: { title: string; count: number; date: Date | string; amount: string } =
  structured.output
// @ts-expect-error text output is not a record
const incorrectText: { title: string } = text.output
// @ts-expect-error structured output is not text
const incorrectStructured: string = structured.output
// @ts-expect-error prompt and messages are mutually exclusive
models.language.generate({ prompt: "Task", messages: [] })
// @ts-expect-error prompt or messages is required
models.language.generate({})
// @ts-expect-error output uses Sixb schemas
models.language.generate({ prompt: "Task", output: { count: "number" } })
// @ts-expect-error a declared structured result requires its runtime output shape
models.language.generate<{ title: "string" }>({ prompt: "Task" })
void [textOutput, structuredOutput, incorrectText, incorrectStructured]
