import type { Broker, Queues } from "@sixb/core"
import { SixbCliError } from "./errors"
import type { LoadedSixb } from "./loadSixb"
import { type ProductionRole, productionRoleFacts } from "./production-roles"

/**
 * The two provider slots that declare whether they cross a process boundary.
 *
 * The storage slots are left out because whether a directory is a shared mount is not something
 * the runtime can know, and a guess would either block a single-node deployment or give false
 * confidence about a multi-replica one.
 */
const SLOTS = [
  {
    name: "queues",
    get: (sixb: LoadedSixb): Broker | Queues => sixb.queues,
    replacements: "@sixb/bullmq",
  },
  {
    name: "broker",
    get: (sixb: LoadedSixb): Broker | Queues => sixb.broker,
    replacements: "@sixb/redis or @sixb/nats",
  },
] as const

function isProcessLocal(slot: (typeof SLOTS)[number], sixb: LoadedSixb): boolean {
  return slot.get(sixb).scope === "process"
}

export interface ProcessLocalProvider {
  /** The config slot: `broker` or `queues`. */
  readonly slot: string
  /** The configured class, so an operator can find it in `sixb.config.ts`. */
  readonly configured: string
  readonly replacements: string
}

/** The same detection as {@link assertShareableProviders}, without the refusal. */
export function findProcessLocalProviders(sixb: LoadedSixb): readonly ProcessLocalProvider[] {
  return SLOTS.filter((slot) => isProcessLocal(slot, sixb)).map((slot) => ({
    slot: slot.name,
    configured: slot.get(sixb).constructor?.name ?? "a process-local provider",
    replacements: slot.replacements,
  }))
}

/**
 * Refuses to start a production role whose broker or queues cannot cross a process boundary.
 *
 * Deployed unchanged, the scaffolded in-memory providers give each role a private set of lanes:
 * the orchestrator enqueues, the worker polls an empty queue, and nothing reports a problem.
 * Throws rather than warns, because an inert deployment is indistinguishable from an idle one.
 */
export function assertShareableProviders(sixb: LoadedSixb, role: ProductionRole): void {
  if (!productionRoleFacts(role).onEventPlane) return

  for (const offender of findProcessLocalProviders(sixb)) {
    throw new SixbCliError(
      `[SixbCLI] \`sixb ${role}\` requires a ${offender.slot} provider that can be shared across ` +
        `processes, but this project configures ${offender.configured}, which only works inside ` +
        `one process. Jobs and events published here would be invisible to every other role.`,
      {
        remediation: `Use ${offender.replacements}, or keep the in-memory provider for \`sixb dev\` only.`,
      }
    )
  }
}
