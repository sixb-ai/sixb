/** Escape plain text for LinkedIn's little format. Do not use on existing mentions/markup. */
export function escapeLinkedinText(text: string): string {
  return text.replace(/[|{}@[\]()<>#\\*_~]/g, "\\$&")
}
