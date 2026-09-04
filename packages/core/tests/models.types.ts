import type {
  LanguageModelCatalog,
  LanguageModelEntry,
  LanguageModelRef,
  ModelCatalogInput,
} from "../src"

declare const input: ModelCatalogInput
declare const catalog: LanguageModelCatalog

const ref: LanguageModelRef = {
  provider: input.language[0]?.provider ?? "gateway",
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
