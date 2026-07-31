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
  /**
   * Three states, not a boolean.
   *
   * `unverified` is a provider that exposes no read-only probe, so nothing was learned
   * about it. It cannot be `ok`: reporting a provider green because it was never asked
   * is the exact reassurance this command exists to stop giving. It cannot be `failed`
   * either — nothing is wrong — so it does not fail a deploy gate.
   */
  readonly status: "ok" | "failed" | "unverified"
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
    warnings: runtimeWarnings(sixb, queues),
  }
}

async function probeStorage(sixb: LoadedSixb, timeoutMs: number): Promise<ProviderCheck> {
  const name = providerName(sixb.storage)
  const reachable = await probe(() => sixb.storage.ping(), name, timeoutMs)
  if (reachable.status !== "ok") return reachable

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

  return schema.status === "ok" && verified
    ? { status: "ok", message: `${schema.message} · schema current` }
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
 * `Queues.health()` is optional because nothing else in that contract is read-only —
 * `enqueue`, `claim`, `complete`, `retry` and `fail` all move work. A provider that
 * implements it gets the same round trip as the other rows; one that does not is
 * reported unverified, which is what the row used to claim was "ok".
 */
async function probeQueues(sixb: LoadedSixb, timeoutMs: number): Promise<ProviderCheck> {
  const name = providerName(sixb.queues)
  // Bound to the provider: `probe` calls it as a bare function, and a queues provider
  // that reads its own connection off `this` would see `undefined`.
  const health = sixb.queues.health?.bind(sixb.queues)
  if (!health) return { status: "unverified", message: `not probed · ${name}` }

  return probe(health, name, timeoutMs)
}

function runtimeWarnings(sixb: LoadedSixb, queues: ProviderCheck): readonly string[] {
  const warnings = findProcessLocalProviders(sixb).map(
    (offender) =>
      `${offender.slot} is ${offender.configured}, which only works inside one process. ` +
      `\`sixb dev\` is fine; production roles will refuse to start. Use ${offender.replacements}.`
  )

  // The yellow row says nothing was learned; this says what to do about it. An operator
  // reading only the warnings block would otherwise take four rows for four probes.
  if (queues.status === "unverified") {
    warnings.push(
      `queues was not probed: ${providerName(sixb.queues)} implements no \`health()\`, so this ` +
        `command cannot tell a reachable backend from an unreachable one. Everything else here ` +
        `was probed.`
    )
  }

  return warnings
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
    return { status: "ok", message: `ok · ${detail}` }
  } catch (error) {
    // Lead a failure with the same provider name the success case shows. Core's reason
    // names the migration *adapter* (`SixbSqliteStorage`), which is not the class an
    // author configured (`SqliteStorage`) — without this the column showed two names for
    // one provider and read like two of them were misconfigured.
    const message = error instanceof Error ? error.message : String(error)
    return { status: "failed", message: `${detail} · ${message}` }
  } finally {
    // Without this the pending timer keeps the event loop alive and the command hangs
    // after printing its panel.
    if (timer) clearTimeout(timer)
  }
}
