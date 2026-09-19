import { BrokerError } from "./errors"
import type { BrokerRetention, BrokerStreamDefinition, BrokerStreamRetention } from "./types"

/** Provider utility: snapshot and validate configuration before opening any connections. */
export function createStreamRetentionResolver(
  configuration: BrokerStreamRetention = {}
): (stream: BrokerStreamDefinition) => BrokerStreamDefinition {
  const overrides = new Map<string, BrokerRetention>()
  for (const [id, retention] of Object.entries(configuration)) {
    if (!id.trim()) throw new BrokerError("Retention stream id must not be empty")
    const limits: Partial<Record<keyof BrokerRetention, number>> = {}
    for (const field of ["maxAgeMs", "maxRecords", "maxBytes"] as const) {
      const value = retention[field]
      if (value === undefined) continue
      if (!Number.isSafeInteger(value) || value <= 0) {
        throw new BrokerError(
          `Retention ${field} for stream '${id}' must be a positive safe integer`
        )
      }
      limits[field] = value
    }
    overrides.set(id, limits)
  }
  return (stream) => {
    const retention = overrides.get(stream.id)
    return retention ? { ...stream, retention: { ...stream.retention, ...retention } } : stream
  }
}
