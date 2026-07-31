import { checkStorageSchema } from "@sixb/core"
import type { LoadedSixb } from "./loadSixb"
import { findProcessLocalProviders } from "./shareable-providers"

/**
 * Every probe is bounded. An unreachable Postgres does not refuse a connection, it
 * waits, and `sixb check` hanging on a dead host tells an operator less than "timed
 * out" does.
 */
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
 * Every row used to be the same literal `{ ok: true, message: "configured" }` — the
 * command reported a healthy runtime against a database that was not there. A check
 * that cannot fail is worse than no check: it is read as evidence.
 *
 * There is no `events` row because there is no events provider: `EventsRuntime` is
 * built over the broker, so probing "events" and probing "the broker" were always the
 * same round trip reported twice. `queues` takes its place — a real config slot that
 * this command never mentioned, and the one where a process-local provider quietly
 * breaks a deployment.
 */
export async function checkRuntimeHealth(
  sixb: LoadedSixb,
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

async function probeStorage(sixb: LoadedSixb, timeoutMs: number): Promise<ProviderCheck> {
  const name = providerName(sixb.storage)
  const reachable = await probe(() => sixb.storage.ping(), name, timeoutMs)
  if (!reachable.ok) return reachable

  // Reachable is not usable. A schema behind this build's migrations is the failure an
  // author is most likely to hit and the one they can act on, so it is worth the second
  // round trip. Shared with `/ready` so both agree on what "usable" means, and bounded
  // for the same reason the connection probe is.
  // `verified: false` means the storage exposes no migrators — usable, but for want of a
  // schema rather than by having a current one. Claiming "schema current" there would be
  // the same empty reassurance this command was built on.
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

async function probeTimeseries(sixb: LoadedSixb): Promise<void> {
  // A read that matches nothing still exercises the telemetry table, which is a
  // different table from the one `ping()` touches.
  await sixb.storage.timeseries.getLatest({
    projectId: sixb.projectId,
    objectTypeId: "__sixb_check",
    objectId: "__sixb_check",
    propertyId: "__sixb_check",
  })
}

async function probeBroker(sixb: LoadedSixb): Promise<void> {
  // `latestCursor` is the only read in the broker contract that neither writes nor
  // requires the stream to exist — it answers `undefined` for a missing one.
  await sixb.events.latestCursor()
}

/**
 * `Queues.health()` is the only read-only member of that contract — everything else
 * enqueues, claims or completes — which is why this row used to be a literal `ok` with no
 * round trip behind it. It is required on the contract, so there is no longer a provider
 * this command cannot ask.
 */
function probeQueues(sixb: LoadedSixb, timeoutMs: number): Promise<ProviderCheck> {
  // Bound to the provider: `probe` calls it as a bare function, and a queues provider
  // that reads its own connection off `this` would see `undefined`.
  return probe(sixb.queues.health.bind(sixb.queues), providerName(sixb.queues), timeoutMs)
}

function processLocalWarnings(sixb: LoadedSixb): readonly string[] {
  return findProcessLocalProviders(sixb).map(
    (offender) =>
      `${offender.slot} is ${offender.configured}, which only works inside one process. ` +
      `\`sixb dev\` is fine; production roles will refuse to start. Use ${offender.replacements}.`
  )
}

/**
 * `?.constructor` rather than a plain read: a provider is a class instance in every
 * configuration we ship, but the contracts are structural, so an object built with
 * `Object.create(null)` satisfies them and has no prototype to name.
 */
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
    // Lead a failure with the same provider name the success case shows. Core's reason
    // names the migration *adapter* (`SixbSqliteStorage`), which is not the class an
    // author configured (`SqliteStorage`) — without this the column showed two names for
    // one provider and read like two of them were misconfigured.
    const message = error instanceof Error ? error.message : String(error)
    return { ok: false, message: `${detail} · ${message}` }
  } finally {
    // Without this the pending timer keeps the event loop alive and the command hangs
    // after printing its panel.
    if (timer) clearTimeout(timer)
  }
}
