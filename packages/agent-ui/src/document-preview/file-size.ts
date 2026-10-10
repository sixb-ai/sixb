import { type AgentMessages, en } from "../i18n/en"

export function formatFileSize(
  sizeBytes: number,
  locale = "en",
  messages: AgentMessages["files"] = en.files
): string {
  if (!Number.isFinite(sizeBytes) || sizeBytes < 0) return messages.unknownSize

  const units = [
    messages.bytes,
    messages.kilobytes,
    messages.megabytes,
    messages.gigabytes,
    messages.terabytes,
  ]
  let value = sizeBytes
  let unitIndex = 0
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024
    unitIndex += 1
  }

  const maximumFractionDigits = unitIndex === 0 || value >= 10 ? 0 : 1
  return `${value.toLocaleString(locale, { maximumFractionDigits })} ${units[unitIndex]}`
}
