import { checkStorageSchema } from "@sixb/core"
import type { LoadedSixbHost } from "./loadSixb"
import { findProcessLocalProviders } from "./shareable-providers"

/** An unreachable Postgres waits rather than refusing, so every probe is bounded. */
const PROBE_TIMEOUT_MS = 5_000

export interface ProviderCheck {
  readonly ok: boolean
  /** What was found. Shown as-is, so it has to read as an answer on its own. */
  readonly message: string
}

export interface RuntimeCheckOptions {
  /** Per-probe bound. Defaults to {@link PROBE_TIMEOUT_MS}. */
  readonly timeoutMs?: number
}

export interface RuntimeCheck {
  readonly storage: ProviderCheck
  readonly timeseries: ProviderCheck
  readonly broker: ProviderCheck
  readonly queues: ProviderCheck
  readonly warnings: readonly string[]
}

/**
 * Probes the configured providers with read-only round trips.
 *
 * There is no `events` row because there is no events provider: `DomainEventService` is built over
 * the broker, so probing both was one round trip reported twice.
 */
export async function checkRuntimeHealth(
  sixb: LoadedSixbHost,
  options: RuntimeCheckOptions = {}
): Promise<RuntimeCheck> {
  const timeoutMs = options.timeoutMs ?? PROBE_TIMEOUT_MS
  const [storage, timeseries, broker, queues] = await Promise.all([
    probeStorage(sixb, timeoutMs),
    probe(() => probeTimeseries(sixb), providerName(sixb.storage), timeoutMs),
    probe(() => probeBroker(sixb), providerName(sixb.broker), timeoutMs),
    probeQueues(sixb, timeoutMs),
  ])

  return {
    storage,
    timeseries,
    broker,
    queues,
    warnings: processLocalWarnings(sixb),
  }
}

async function probeStorage(sixb: LoadedSixbHost, timeoutMs: number): Promise<ProviderCheck> {
  const name = providerName(sixb.storage)
  const reachable = await probe(() => sixb.storage.ping(), name, timeoutMs)
  if (!reachable.ok) return reachable

  // Reachable is not usable, so a second round trip checks the schema — shared with `/ready`
  // so both agree on what usable means. `verified: false` means the storage exposes no
  // migrators: usable for want of a schema rather than by having a current one.
  let verified = false
  const schema = await probe(
    async () => {
      const result = await checkStorageSchema(sixb.storage)
      verified = result.verified
      if (!result.ok) throw new Error(result.reason ?? "schema is not usable")
    },
    name,
    timeoutMs
  )

  return schema.ok && verified
    ? { ok: true, message: `${schema.message} · schema current` }
    : schema
}

async function probeTimeseries(sixb: LoadedSixbHost): Promise<void> {
  // A read that matches nothing still exercises the telemetry table, which is a
  // different table from the one `ping()` touches.
  await sixb.storage.timeseries.getLatest({
    projectId: sixb.projectId,
    objectTypeId: "__sixb_check",
    objectId: "__sixb_check",
    propertyId: "__sixb_check",
  })
}

async function probeBroker(sixb: LoadedSixbHost): Promise<void> {
  // `latestCursor` is the only read in the broker contract that neither writes nor
  // requires the stream to exist — it answers `undefined` for a missing one.
  await sixb.events.latestCursor()
}

function probeQueues(sixb: LoadedSixbHost, timeoutMs: number): Promise<ProviderCheck> {
  // Bound to the provider: `probe` calls it as a bare function, and a queues provider
  // that reads its own connection off `this` would see `undefined`.
  return probe(sixb.queues.health.bind(sixb.queues), providerName(sixb.queues), timeoutMs)
}

function processLocalWarnings(sixb: LoadedSixbHost): readonly string[] {
  return findProcessLocalProviders(sixb).map(
    (offender) =>
      `${offender.slot} is ${offender.configured}, which only works inside one process. ` +
      `\`sixb dev\` is fine; production roles will refuse to start. Use ${offender.replacements}.`
  )
}

/** `?.constructor`: the contracts are structural, so a prototype-less object satisfies them. */
function providerName(provider: object): string {
  return provider.constructor?.name ?? "unknown"
}

async function probe(
  run: () => Promise<unknown>,
  detail: string,
  timeoutMs: number
): Promise<ProviderCheck> {
  let timer: ReturnType<typeof setTimeout> | undefined

  try {
    await Promise.race([
      run(),
      new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs)
      }),
    ])
    return { ok: true, message: `ok · ${detail}` }
  } catch (error) {
    // Led by the configured class, because core's reason names the migration adapter
    // (`SixbSqliteStorage`) rather than what the author wrote (`SqliteStorage`).
    const message = error instanceof Error ? error.message : String(error)
    return { ok: false, message: `${detail} · ${message}` }
  } finally {
    // A pending timer keeps the event loop alive and hangs the command after it prints.
    if (timer) clearTimeout(timer)
  }
}
