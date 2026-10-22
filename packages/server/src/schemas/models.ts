import { MODEL_REASONING_LEVELS } from "@sixb/core/models"
import { z } from "zod"
import { FileRefSchema } from "./files"

export const LanguageModelRefSchema = z.object({
  provider: z.string().trim().min(1),
  modelId: z.string().trim().min(1),
})

const DecimalSchema = z.string().regex(/^(?:0|[1-9]\d*)(?:\.\d+)?$/)

const TokenPriceSchema = z.union([
  DecimalSchema,
  z.object({
    default: DecimalSchema,
    tiers: z.array(
      z.object({
        minTokens: z.number().int().nonnegative(),
        maxTokens: z.number().int().positive().optional(),
        price: DecimalSchema,
      })
    ),
  }),
])

const VariantPriceSchema = z.union([
  DecimalSchema,
  z.object({
    default: DecimalSchema.optional(),
    variants: z.array(
      z.object({
        size: z.string().optional(),
        quality: z.string().optional(),
        style: z.string().optional(),
        voiceTier: z.string().optional(),
        price: DecimalSchema,
      })
    ),
  }),
])

/** The prices a binding bills by. Absent when the price is unknown. */
export const ModelRateCardSchema = z
  .object({
    currency: z.literal("USD"),
    input: TokenPriceSchema.optional(),
    output: TokenPriceSchema.optional(),
    cacheReadInput: TokenPriceSchema.optional(),
    cacheWriteInput: TokenPriceSchema.optional(),
    cacheWriteInput5m: TokenPriceSchema.optional(),
    cacheWriteInput1h: TokenPriceSchema.optional(),
    imageOutput: TokenPriceSchema.optional(),
    audioOutput: TokenPriceSchema.optional(),
    images: VariantPriceSchema.optional(),
    characters: VariantPriceSchema.optional(),
    audioInputSeconds: VariantPriceSchema.optional(),
  })
  .describe("USD. Token and character prices are per million; images per image; audio per second.")

export const LanguageModelSchema = LanguageModelRefSchema.extend({
  /**
   * The provider binding and model id the project configured. Together they identify the entry;
   * there is no separate Sixb model id.
   */
  isDefault: z.boolean(),
  name: z.string().min(1),
  description: z.string().min(1).optional(),
  publisher: z.object({
    id: z.string().min(1),
    name: z.string().min(1),
  }),
  via: z.string().min(1).optional(),
  capabilities: z.object({
    input: z.array(z.enum(["text", "image", "audio", "video", "pdf"])),
    output: z.array(z.enum(["text", "image", "audio", "video", "pdf"])),
    attachments: z.boolean().optional(),
    reasoning: z.boolean().optional(),
    tools: z.boolean().optional(),
    structuredOutput: z.boolean().optional(),
    contextWindowTokens: z.number().int().positive().optional(),
  }),
  reasoningLevels: z.array(z.enum(MODEL_REASONING_LEVELS)),
  /** Reasoning the project applies when a request selects this model without choosing one. */
  defaultReasoning: z.enum(MODEL_REASONING_LEVELS).optional(),
  rateCard: ModelRateCardSchema.optional(),
})

const CatalogEntrySchema = LanguageModelRefSchema.extend({
  isDefault: z.boolean(),
  name: z.string().min(1),
  description: z.string().min(1).optional(),
  via: z.string().min(1).optional(),
  rateCard: ModelRateCardSchema.optional(),
})

const ListSchema = z.array(z.string().min(1)).optional()

export const ImageModelSchema = CatalogEntrySchema.extend({
  maxImagesPerCall: z.number().int().positive().optional(),
  sizes: ListSchema,
  aspectRatios: ListSchema,
  qualities: ListSchema,
  styles: ListSchema,
  inputImages: z
    .object({
      maxCount: z.number().int().positive(),
      maxBytes: z.number().int().positive(),
      mediaTypes: ListSchema,
    })
    .optional()
    .describe("Reference images the model takes for edits; absent when it takes none."),
})

export const SpeechModelSchema = CatalogEntrySchema.extend({
  defaultVoice: z.string().min(1).optional(),
  voices: ListSchema,
  outputMediaTypes: ListSchema,
  maxInputCharacters: z.number().int().positive().optional(),
  instructions: z.boolean().optional(),
})

export const TranscriptionModelSchema = CatalogEntrySchema.extend({
  maxInputBytes: z.number().int().positive(),
  mediaTypes: ListSchema,
})

export const ModelCatalogSchema = z.object({
  language: z.array(LanguageModelSchema),
  image: z.array(ImageModelSchema),
  audio: z.object({
    speech: z.array(SpeechModelSchema),
    transcription: z.array(TranscriptionModelSchema),
  }),
})

export const ModelReasoningLevelSchema = z.enum(MODEL_REASONING_LEVELS)

export const ModelReasoningSchema = z.union([
  ModelReasoningLevelSchema,
  z.object({ budgetTokens: z.number().int().nonnegative() }).strict(),
])

export const ModelCallParamsSchema = z.object({
  callId: z.string().min(1),
})

export const ModelCallFilesSchema = z.object({
  callId: z.string(),
  files: z.array(FileRefSchema),
  recordedAt: z.string(),
})

const ModelUsageSchema = z.object({
  inputTokens: z.number().int().nonnegative().optional(),
  outputTokens: z.number().int().nonnegative().optional(),
  uncachedInputTokens: z.number().int().nonnegative().optional(),
  cacheReadInputTokens: z.number().int().nonnegative().optional(),
  cacheWriteInputTokens: z.number().int().nonnegative().optional(),
  textOutputTokens: z.number().int().nonnegative().optional(),
  reasoningOutputTokens: z.number().int().nonnegative().optional(),
  imageOutputTokens: z.number().int().nonnegative().optional(),
  audioOutputTokens: z.number().int().nonnegative().optional(),
  outputImages: z.number().int().nonnegative().optional(),
  inputCharacters: z.number().int().nonnegative().optional(),
  audioDurationMs: z.number().int().nonnegative().optional(),
})

/** What the call cost: reported by the provider, rated from the binding's card, or unknown. */
const ModelCallCostSchema = z.object({
  status: z.enum(["reported", "rated", "unpriceable"]),
  money: z.object({ currency: z.literal("USD"), amountNanos: z.string() }).optional(),
  reason: z.string().optional(),
})

const GenerationBodyBase = z.object({
  /** Omit for the kind's default model. */
  model: LanguageModelRefSchema.optional(),
})

const GenerationResultBase = z.object({
  callId: z.string(),
  model: LanguageModelRefSchema,
  usage: ModelUsageSchema,
  cost: ModelCallCostSchema,
})

export const TextGenerationBodySchema = GenerationBodyBase.extend({
  prompt: z.string().trim().min(1),
  instructions: z.string().optional(),
  maxOutputTokens: z.number().int().positive().optional(),
  reasoning: ModelReasoningSchema.optional(),
})

export const TextGenerationSchema = GenerationResultBase.extend({
  text: z.string(),
  finishReason: z.string(),
})

export const ImageGenerationBodySchema = GenerationBodyBase.extend({
  prompt: z.string().trim().min(1),
  n: z.number().int().positive().optional(),
  size: z.string().min(1).optional(),
  aspectRatio: z.string().min(1).optional(),
  quality: z.string().min(1).optional(),
  style: z.string().min(1).optional(),
  seed: z.number().int().optional(),
  /** Reference images uploaded through /api/files. */
  images: z.array(FileRefSchema).optional(),
})

export const SpeechGenerationBodySchema = GenerationBodyBase.extend({
  text: z.string().trim().min(1),
  voice: z.string().min(1).optional(),
  instructions: z.string().optional(),
  mediaType: z.string().min(1).optional(),
  speed: z.number().positive().optional(),
  language: z.string().min(1).optional(),
})

export const FileGenerationSchema = GenerationResultBase.extend({
  files: z.array(FileRefSchema),
  warnings: z.array(z.string()),
})

export const TranscriptionBodySchema = GenerationBodyBase.extend({
  /** Audio uploaded through /api/files. */
  audio: FileRefSchema,
})

export const TranscriptionSchema = GenerationResultBase.extend({
  text: z.string(),
})
