import {
  createModelCatalog,
  type DecisionModel,
  type LanguageModel,
  type ModelCatalogInput,
} from "../src/models"

declare const decision: DecisionModel
declare const language: LanguageModel

const decisions = createModelCatalog({ decision: [decision] })
const languages = createModelCatalog({ language: [language] })
const mixed = createModelCatalog({ language: [language], decision: [decision] })
const firstDecision: DecisionModel = decisions.decision.default.model
const firstLanguage: LanguageModel = languages.language.default.model
const mixedDecision: DecisionModel = mixed.decision.default.model
const mixedLanguage: LanguageModel = mixed.language.default.model
decisions.embedding.list()

// @ts-expect-error A decision-only configuration does not guarantee a language catalog.
decisions.language.default
// @ts-expect-error A language-only configuration does not guarantee a decision catalog.
languages.decision.default
// @ts-expect-error Embeddings have no implicit default.
mixed.embedding.default

declare const optional: ModelCatalogInput
const optionalCatalog = createModelCatalog(optional)
// @ts-expect-error An optional input must retain an optional output.
optionalCatalog.decision.default

declare const either:
  | { language: readonly LanguageModel[] }
  | { decision: readonly DecisionModel[] }
const eitherCatalog = createModelCatalog(either)
// @ts-expect-error A union of configurations does not guarantee either catalog individually.
eitherCatalog.language.default
// @ts-expect-error A union of configurations does not guarantee either catalog individually.
eitherCatalog.decision.default

void [firstDecision, firstLanguage, mixedDecision, mixedLanguage]
