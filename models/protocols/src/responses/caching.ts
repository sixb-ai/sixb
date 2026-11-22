/**
 * OpenAI GPT-5.6 and later bill cache writes, at 1.25 times input for their default 30 minutes,
 * and take `prompt_cache_options`; earlier models write for free and reject that field with a
 * 400. `model` is OpenAI's model name, such as `gpt-6.2-sol`.
 */
export function billsPromptCacheWrites(model: string): boolean {
  return /^gpt-(?:5\.(?:[6-9]|\d{2,})|(?:[6-9]|\d{2,})(?:\.\d+)?)(?:-|$)/.test(model.toLowerCase())
}
