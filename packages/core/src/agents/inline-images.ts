/**
 * The image data one Agent request carries inline, at most. Gemini takes 20 MB of inline request
 * data, Anthropic 32 MB and 100 images per request, OpenAI 50 MB of images: 16 MiB of encoded
 * images leaves even Gemini more than 3 MB for the text.
 */
export const AGENT_INLINE_IMAGE_LIMITS = {
  maxBytes: 16 * 1024 * 1024,
  maxImages: 100,
} as const

/**
 * The input tokens an inline image counts for, wherever the runtime estimates a request. Sixb sends
 * no image above 2,000 × 2,000 px: 5,334 tokens at 750 px per token, which Anthropic models that
 * read images at full resolution charge. Anthropic's usual downscale to 1.15 MP charges about 1,600, and
 * other providers less: the larger figure keeps every estimate on the side that cannot overflow.
 */
export const AGENT_IMAGE_INPUT_TOKENS = 5_400
