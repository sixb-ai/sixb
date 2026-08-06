/**
 * Publish every locally-versioned Sixb package that is not yet on npm, in dependency order.
 *
 *   bun scripts/publish.ts --plan
 *   bun scripts/publish.ts --dry-run
 *   bun scripts/publish.ts --tag next
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
import {
  discoverPublishablePackages,
  packageName,
  topologicalPublishOrder,
} from "./publishable-packages"
import {
  createPackageReleasePlan,
  type PackageRegistryState,
  type PlannedPackageRelease,
  packageReleaseId,
} from "./release-plan"
import { assertReleaseTagAllowed, isPreviewRelease } from "./release-policy"

const root = process.cwd()
const options = parseOptions(process.argv.slice(2))
const ordered = topologicalPublishOrder(await discoverPublishablePackages(root))
const registryByName = new Map(
  await Promise.all(
    ordered.map(async (packageInfo) => {
      const name = packageName(packageInfo)
      return [name, await readRegistryState(name)] as const
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
    `${plan.alreadyPublished} already on the registry, tag "${options.tag}".`
)
for (const release of plan.publish) console.log(`  ${packageReleaseId(release)}`)

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
      `[SixbPublish] Promote once you have verified the tag:\n` +
        stable.map((release) => `  npm dist-tag add ${packageReleaseId(release)} latest`).join("\n")
    )
  }
}

async function publishPackage(release: PlannedPackageRelease): Promise<void> {
  const args = [process.execPath, "publish", "--tag", options.tag]
  if (options.dryRun) args.push("--dry-run")
  if (options.otp) args.push("--otp", options.otp)
  if (options.registry) args.push("--registry", options.registry)

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

/**
 * Read registry state before any write so a network or authentication-adjacent lookup failure
 * cannot leave a release half-published. A 404 is a new package with no versions or tags yet.
 */
async function readRegistryState(name: string): Promise<PackageRegistryState> {
  const registry = (options.registry ?? "https://registry.npmjs.org").replace(/\/+$/, "")
  const response = await fetch(`${registry}/${encodeURIComponent(name)}`, {
    headers: { accept: "application/vnd.npm.install-v1+json" },
  })

  if (response.status === 404) return { versions: new Set(), tags: {} }
  if (!response.ok) {
    throw new Error(`[SixbPublish] Could not query the registry for ${name}: ${response.status}`)
  }

  const body = (await response.json()) as {
    versions?: Record<string, unknown>
    "dist-tags"?: Record<string, string>
  }
  return {
    versions: new Set(Object.keys(body.versions ?? {})),
    tags: body["dist-tags"] ?? {},
  }
}

function uniqueReleases(releases: readonly PlannedPackageRelease[]): PlannedPackageRelease[] {
  return [...new Map(releases.map((release) => [packageReleaseId(release), release])).values()]
}

interface PublishOptions {
  readonly dryRun: boolean
  readonly planOnly: boolean
  readonly tag: string
  readonly otp?: string
  readonly registry?: string
}

function parseOptions(argv: string[]): PublishOptions {
  const values = new Map<string, string>()
  let dryRun = false
  let planOnly = false

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (arg === "--dry-run") {
      dryRun = true
      continue
    }
    if (arg === "--plan") {
      planOnly = true
      continue
    }
    if (arg === "--tag" || arg === "--otp" || arg === "--registry") {
      const value = argv[index + 1]
      if (!value || value.startsWith("--")) {
        throw new Error(`[SixbPublish] ${arg} needs a value.`)
      }
      values.set(arg, value)
      index++
      continue
    }
    throw new Error(
      `[SixbPublish] Unknown argument ${arg}. Usage: bun scripts/publish.ts ` +
        "[--plan] [--dry-run] [--tag <tag>] [--otp <code>] [--registry <url>]"
    )
  }

  const otp = values.get("--otp")
  const registry = values.get("--registry")
  return {
    dryRun,
    planOnly,
    tag: values.get("--tag") ?? "latest",
    ...(otp ? { otp } : {}),
    ...(registry ? { registry } : {}),
  }
}
