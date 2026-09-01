/**
 * Promote every locally-versioned package staged under one npm dist-tag to another.
 *
 *   bun scripts/promote.ts --plan
 *   bun scripts/promote.ts
 *   bun scripts/promote.ts --from next --to latest
 *   bun scripts/promote.ts --registry http://localhost:4873
 *
 * Authenticate once with `bunx npm login --auth-type=web` before running this command. The complete
 * registry state is validated before the first write. An interrupted promotion can be resumed:
 * packages already on the target tag are skipped.
 */
import { publicNpmRegistry, readRegistryState } from "./npm-registry"
import { parsePromoteOptions } from "./promote-options"
import { createPackagePromotionPlan } from "./promotion-plan"
import {
  discoverPublishablePackages,
  packageName,
  topologicalPublishOrder,
} from "./publishable-packages"
import { type PlannedPackageRelease, packageReleaseId } from "./release-plan"

const root = process.cwd()
const options = parsePromoteOptions(process.argv.slice(2))
const registry = options.registry ?? publicNpmRegistry
const ordered = topologicalPublishOrder(await discoverPublishablePackages(root))
const registryByName = new Map(
  await Promise.all(
    ordered.map(async (packageInfo) => {
      const name = packageName(packageInfo)
      return [name, await readRegistryState(name, registry)] as const
    })
  )
)
const plan = createPackagePromotionPlan(
  ordered,
  registryByName,
  options.sourceTag,
  options.targetTag
)

console.log(
  `[SixbPromote] ${options.planOnly ? "Plan: " : ""}${plan.promote.length} to promote from ` +
    `"${options.sourceTag}" to "${options.targetTag}", ` +
    `${plan.alreadyPromoted} already promoted.`
)
for (const release of plan.promote) console.log(`  ${packageReleaseId(release)}`)

const promoted: string[] = []
for (const [index, release] of (options.planOnly ? [] : plan.promote).entries()) {
  const position = `${String(index + 1).padStart(2, " ")}/${plan.promote.length}`
  const id = packageReleaseId(release)
  console.log(`[SixbPromote] ${position} ${id}`)
  await promotePackage(release)
  promoted.push(id)
}

if (options.planOnly) {
  console.log("[SixbPromote] Plan complete. No dist-tag was changed.")
} else {
  await verifyPromotions(plan.promote)
  console.log(`[SixbPromote] Done. ${promoted.length} promoted and verified.`)
}

async function promotePackage(release: PlannedPackageRelease): Promise<void> {
  const args = [
    process.execPath,
    "x",
    "npm",
    "dist-tag",
    "add",
    packageReleaseId(release),
    options.targetTag,
    "--registry",
    registry,
  ]
  if (options.otp) args.push("--otp", options.otp)

  const proc = Bun.spawn(args, {
    cwd: root,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  })
  const exitCode = await proc.exited
  if (exitCode === 0) return

  throw new Error(
    `[SixbPromote] Failed to promote ${packageReleaseId(release)}.\n\n` +
      `Promoted so far: ${promoted.length > 0 ? promoted.join(", ") : "nothing"}\n` +
      "Fix the cause and re-run; packages already on the target tag are skipped."
  )
}

async function verifyPromotions(releases: readonly PlannedPackageRelease[]): Promise<void> {
  console.log(`[SixbPromote] Verifying "${options.targetTag}" tags...`)
  const results = await Promise.all(releases.map(verifyPromotion))
  const failures = results.filter((result): result is string => result !== undefined)

  if (failures.length > 0) {
    throw new Error(`[SixbPromote] Promotion verification failed:\n  ${failures.join("\n  ")}`)
  }
}

async function verifyPromotion(release: PlannedPackageRelease): Promise<string | undefined> {
  let actual: string | undefined

  // npm can acknowledge a dist-tag write before every public registry edge serves it. Allow up to
  // roughly 32 seconds of propagation before reporting a promotion that may actually have failed.
  for (let attempt = 0; attempt < 8; attempt++) {
    const state = await readRegistryState(release.name, registry)
    actual = state.tags[options.targetTag]
    if (actual === release.version) {
      console.log(`  ${options.targetTag} ${packageReleaseId(release)}`)
      return undefined
    }
    if (attempt < 7) await Bun.sleep(250 * 2 ** attempt)
  }

  return `${release.name} expected ${release.version}, found ${actual ?? "no tag"}`
}
