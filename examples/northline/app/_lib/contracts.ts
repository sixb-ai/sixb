const contractTypes: Readonly<Record<string, string>> = {
  full_service: "Full service",
  priority_care: "PriorityCare",
  preventive: "Preventive",
}

/** A contract type as customers know it: "PriorityCare" rather than "Priority care". */
export function contractTypeLabel(type: string): string {
  return contractTypes[type] ?? type
}

/** A contract in force: active, or active and nearing its end. */
export function isContractCurrent(status: string): boolean {
  return status === "active" || status === "expiring"
}
