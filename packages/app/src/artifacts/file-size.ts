export interface FileSizeUnits {
  readonly unknownSize: string
  readonly bytes: string
  readonly kilobytes: string
  readonly megabytes: string
  readonly gigabytes: string
  readonly terabytes: string
}

/** A byte count in the largest unit that keeps it at least 1, in the reader's locale. */
export function formatFileSize(sizeBytes: number, locale: string, units: FileSizeUnits): string {
  if (!Number.isFinite(sizeBytes) || sizeBytes < 0) return units.unknownSize

  const names = [units.bytes, units.kilobytes, units.megabytes, units.gigabytes, units.terabytes]
  let value = sizeBytes
  let unitIndex = 0
  while (value >= 1024 && unitIndex < names.length - 1) {
    value /= 1024
    unitIndex += 1
  }

  const maximumFractionDigits = unitIndex === 0 || value >= 10 ? 0 : 1
  return `${value.toLocaleString(locale, { maximumFractionDigits })} ${names[unitIndex]}`
}
