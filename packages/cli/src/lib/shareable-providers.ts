import { InMemoryBroker, InMemoryQueues } from "@sixb/core"
import type { LoadedSixb } from "./loadSixb"

/**
 * Every long-running production role, and whether it publishes to or claims from the
 * event plane.
 *
 * `atlas` and `app` only serve a browser bundle: they read `auth.isEnabled()` and the
 * project id off the runtime and never touch the broker or the queues, so a
 * process-local provider cannot hurt them and refusing to boot would block a valid
 * UI-only container.
 *
 * This is a total map over the role union on purpose. A new role does not compile
 * until it appears here, which forces the question to be answered once rather than
 * discovered in production.
 */
const ROLES = {
  api: { onEventPlane: true },
  rules: { onEventPlane: true },
  scheduler: { onEventPlane: true },
  orchestrator: { onEventPlane: true },
  worker: { onEventPlane: true },
  "worker-group": { onEventPlane: true },
  atlas: { onEventPlane: false },
  app: { onEventPlane: false },
} as const satisfies Record<string, { readonly onEventPlane: boolean }>

export type ProductionRole = keyof typeof ROLES

/**
 * The two provider slots that only work inside one process.
 *
 * Storage, lake storage and blob storage are left out on purpose. Local files and
 * SQLite survive a restart, and whether a directory is a shared mount is not
 * something the runtime can know — a guess there would either block a legitimate
 * single-node deployment or give false confidence about a multi-replica one. Brokers
 * and queues are different: an in-memory one is process-local by construction, and
 * that is decidable.
 */
const SLOTS = [
  {
    name: "queues",
    get: (sixb: LoadedSixb) => sixb.queues as unknown,
    isKnownProcessLocal: (value: unknown) => value instanceof InMemoryQueues,
    replacements: "@sixb/bullmq",
  },
  {
    name: "broker",
    get: (sixb: LoadedSixb) => sixb.broker as unknown,
    isKnownProcessLocal: (value: unknown) => value instanceof InMemoryBroker,
    replacements: "@sixb/redis or @sixb/nats",
  },
] as const

function isProcessLocal(slot: (typeof SLOTS)[number], sixb: LoadedSixb): boolean {
  const provider = slot.get(sixb)
  // `instanceof` first, then the declared marker. Two copies of @sixb/core in one
  // dependency graph defeat `instanceof`, and a hand-written test double declares the
  // marker without extending our class.
  return (
    slot.isKnownProcessLocal(provider) ||
    (provider as { processLocal?: unknown } | null | undefined)?.processLocal === true
  )
}

/**
 * Refuses to start a production role whose broker or queues cannot cross a process
 * boundary.
 *
 * The scaffolded config ships `InMemoryBroker` and `InMemoryQueues` because
 * `sixb dev` runs everything in one process. Deploy it unchanged and the API, the
 * orchestrator and the workers each get a private set of lanes: the orchestrator
 * enqueues, the worker polls an empty queue, and nothing reports a problem. Only
 * `sixb worker` and `sixb worker-group` used to catch it, and only for queues.
 *
 * Throws rather than warns, matching what those two already did — a warning in a
 * startup log is not read, and an inert deployment is indistinguishable from an idle
 * one. There is no environment-variable escape hatch: a host that genuinely wants
 * these implements the contract without declaring the marker, the way the CLI's own
 * role fixtures do.
 */
export function assertShareableProviders(sixb: LoadedSixb, role: ProductionRole): void {
  if (!ROLES[role].onEventPlane) return

  for (const slot of SLOTS) {
    if (!isProcessLocal(slot, sixb)) continue

    // Name the offending class, not just the slot: "you configured InMemoryQueues" is
    // something an operator can go find in sixb.config.ts.
    const configured = slot.get(sixb)?.constructor?.name ?? "a process-local provider"

    throw new Error(
      `[SixbCLI] \`sixb ${role}\` requires a ${slot.name} provider that can be shared across ` +
        `processes, but this project configures ${configured}, which only works inside one ` +
        `process. Jobs and events published here would be invisible to every other role. Use ` +
        `${slot.replacements}, or keep the in-memory provider for \`sixb dev\` only.`
    )
  }
}
