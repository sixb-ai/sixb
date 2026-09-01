/**
 * Publish every locally-versioned Sixb package that is not yet on npm, in dependency order.
 *
 *   bun scripts/publish.ts --plan
 *   bun scripts/publish.ts --dry-run
 *   bun scripts/publish.ts --tag next
 *   bun scripts/publish.ts --tag next --auth-type web  # passkey / browser challenge
 *   bun scripts/publish.ts --tag next --otp 123456
 *   bun scripts/publish.ts --tag next --registry http://localhost:4873  # local rehearsal
 *
 * Run `bun run release` first: it installs from the lockfile, rebuilds from clean, and runs the
 * publish gate. This script only publishes. Preview 0.0.x versions must use `--tag next`; `latest`
 * starts at 0.1.0.
 *
 * A package manifest is its release intent: bump the packages that should ship and leave every other
 * manifest alone. Registry state is read for the whole workspace before the first write, and an
 * existing package version is skipped so an interrupted run can resume safely.
 *
 * Note that `bun publish --dry-run` still authenticates, so a dry run needs a token. To rehearse the
 * whole thing with no credentials and no public side effects, point `--registry` at a local registry.
 */
import { join } from "node:path"
import { publicNpmRegistry, readRegistryState } from "./npm-registry"
import { parsePublishOptions } from "./publish-options"
import {
  discoverPublishablePackages,
  packageName,
  topologicalPublishOrder,
} from "./publishable-packages"
import {
  createPackageReleasePlan,
  type PlannedPackageRelease,
  packageReleaseId,
} from "./release-plan"
import { assertReleaseTagAllowed, isPreviewRelease } from "./release-policy"

const root = process.cwd()
const options = parsePublishOptions(process.argv.slice(2))
const ordered = topologicalPublishOrder(await discoverPublishablePackages(root))
const registryByName = new Map(
  await Promise.all(
    ordered.map(async (packageInfo) => {
      const name = packageName(packageInfo)
      return [name, await readRegistryState(name, options.registry ?? publicNpmRegistry)] as const
    })
  )
)
const plan = createPackageReleasePlan(ordered, registryByName, options.tag)

for (const release of plan.publish) {
  assertReleaseTagAllowed(release.version, options.tag)
}

console.log(
  `[SixbPublish] ${options.planOnly ? "Plan: " : options.dryRun ? "Dry run: " : ""}` +
    `${plan.publish.length} to publish, ` +
    `${plan.deferredInitial.length} initial ${plan.deferredInitial.length === 1 ? "package" : "packages"} deferred, ` +
    `${plan.alreadyPublished} already on the registry, tag "${options.tag}".`
)
for (const release of plan.publish) console.log(`  ${packageReleaseId(release)}`)

if (plan.deferredInitial.length > 0) {
  console.log(
    `[SixbPublish] Initial ${plan.deferredInitial.length === 1 ? "package" : "packages"} not staged:\n` +
      plan.deferredInitial.map((release) => `  ${packageReleaseId(release)}`).join("\n") +
      "\nBun assigns `latest` on an initial publish even with another `--tag`. " +
      "Rehearse the bootstrap on a local registry, then publish it explicitly with `--tag latest` " +
      "once it is ready to become the default install."
  )
}

const published: string[] = []

for (const [index, release] of (options.planOnly ? [] : plan.publish).entries()) {
  const position = `${String(index + 1).padStart(2, " ")}/${plan.publish.length}`
  const id = packageReleaseId(release)
  console.log(`[SixbPublish] ${position} ${id}`)
  await publishPackage(release)
  published.push(id)
}

console.log(
  options.planOnly
    ? "[SixbPublish] Plan complete. Nothing was published."
    : options.dryRun
      ? `[SixbPublish] Dry run complete. ${published.length} validated.`
      : `[SixbPublish] Done. ${published.length} published.`
)

if (options.tag !== "latest" && !options.dryRun && !options.planOnly) {
  const promotion = uniqueReleases([...plan.stagedForPromotion, ...plan.publish])
  const previews = promotion.filter((release) => isPreviewRelease(release.version))
  const stable = promotion.filter((release) => !isPreviewRelease(release.version))

  if (previews.length > 0) {
    console.log(
      `[SixbPublish] ${previews.map(packageReleaseId).join(", ")} remain on "${options.tag}". ` +
        'The "latest" tag is reserved for 0.1.0 and later.'
    )
  }
  if (stable.length > 0) {
    console.log(
      `[SixbPublish] ${stable.length} stable ${stable.length === 1 ? "package is" : "packages are"} ` +
        `ready for promotion. Verify with \`bun run release:promote -- --plan\`, then run ` +
        "`bun run release:promote`."
    )
  }
}

async function publishPackage(release: PlannedPackageRelease): Promise<void> {
  const args = [process.execPath, "publish", "--tag", options.tag]
  if (options.dryRun) args.push("--dry-run")
  if (options.authType) args.push("--auth-type", options.authType)
  if (options.otp) args.push("--otp", options.otp)
  if (options.registry) args.push("--registry", options.registry)

  if (options.authType) {
    const proc = Bun.spawn(args, {
      cwd: join(root, release.packageInfo.dir),
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    })
    const exitCode = await proc.exited

    if (exitCode === 0) return

    throw new Error(
      `[SixbPublish] Failed to publish ${packageReleaseId(release)}; see the interactive output above.\n\n` +
        `Published so far: ${published.length > 0 ? published.join(", ") : "nothing"}\n` +
        "Fix the cause and re-run; packages already on the registry are skipped."
    )
  }

  const proc = Bun.spawn(args, {
    cwd: join(root, release.packageInfo.dir),
    stdout: "pipe",
    stderr: "pipe",
  })

  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])

  if (exitCode === 0) return

  const output = `${stdout}${stderr}`
  // The per-file "packed …" listing is thousands of lines and buries the reason.
  const reason = output
    .split(/\r?\n/)
    .filter((line) => line.trim() && !line.startsWith("packed "))
    .slice(-12)
    .join("\n")

  throw new Error(
    `[SixbPublish] Failed to publish ${packageReleaseId(release)}.\n${reason}\n\n` +
      (output.includes("missing authentication")
        ? "Run `bunx npm login` first — `bun publish` authenticates even for --dry-run.\n"
        : "") +
      `Published so far: ${published.length > 0 ? published.join(", ") : "nothing"}\n` +
      "Fix the cause and re-run; packages already on the registry are skipped."
  )
}

function uniqueReleases(releases: readonly PlannedPackageRelease[]): PlannedPackageRelease[] {
  return [...new Map(releases.map((release) => [packageReleaseId(release), release])).values()]
}
