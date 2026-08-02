/**
 * Publish every Sixb package to npm, in dependency order.
 *
 *   bun scripts/publish.ts --dry-run
 *   bun scripts/publish.ts --tag next
 *   bun scripts/publish.ts --tag next --otp 123456
 *   bun scripts/publish.ts --tag next --registry http://localhost:4873  # local rehearsal
 *
 * Run `bun run release` first: it installs from the lockfile, rebuilds from clean, and runs the
 * publish gate. This script only publishes. Preview 0.0.x versions must use `--tag next`; `latest`
 * starts at 0.1.0.
 *
 * Publishing 46 packages is 46 separate registry writes, so it is resumable by design: a version
 * already on the registry is skipped rather than retried, and a failure stops the run naming exactly
 * what got through. Re-running after fixing the cause continues where it stopped.
 *
 * Note that `bun publish --dry-run` still authenticates, so a dry run needs a token. To rehearse the
 * whole thing with no credentials and no public side effects, point `--registry` at a local registry.
 */
import { join } from "node:path"
import {
  discoverPublishablePackages,
  type PublishablePackage,
  packageName,
  topologicalPublishOrder,
} from "./publishable-packages"
import { assertReleaseTagAllowed, isPreviewRelease } from "./release-policy"

const root = process.cwd()
const options = parseOptions(process.argv.slice(2))
const ordered = topologicalPublishOrder(await discoverPublishablePackages(root))

const versions = new Set(ordered.map((packageInfo) => packageInfo.packageJson.version))
if (versions.size !== 1) {
  throw new Error(
    `[SixbPublish] Packages are not on one version (${[...versions].join(", ")}). Run \`bun run test:publish\`.`
  )
}
const [version] = [...versions]
if (!version) throw new Error("[SixbPublish] Packages have no version.")
assertReleaseTagAllowed(version, options.tag)

console.log(
  `[SixbPublish] ${options.dryRun ? "Dry run: " : ""}publishing ${ordered.length} packages at ${version} to tag "${options.tag}".`
)

const skipped: string[] = []
const published: string[] = []

for (const [index, packageInfo] of ordered.entries()) {
  const name = packageName(packageInfo)
  const position = `${String(index + 1).padStart(2, " ")}/${ordered.length}`

  if (await isAlreadyPublished(name, version)) {
    skipped.push(name)
    console.log(`[SixbPublish] ${position} ${name}@${version} already on the registry, skipping.`)
    continue
  }

  console.log(`[SixbPublish] ${position} ${name}`)
  await publishPackage(packageInfo, name)
  published.push(name)
}

console.log(
  `[SixbPublish] Done. ${published.length} published, ${skipped.length} already on the registry.`
)
if (options.tag !== "latest" && !options.dryRun && published.length > 0) {
  if (isPreviewRelease(version)) {
    console.log(
      `[SixbPublish] ${version} remains on "${options.tag}". ` +
        'The "latest" tag is reserved for 0.1.0 and later.'
    )
  } else {
    console.log(
      `[SixbPublish] Nothing is on "latest" yet. Promote once you have verified the tag:\n` +
        ordered
          .map((packageInfo) => `  npm dist-tag add ${packageName(packageInfo)}@${version} latest`)
          .join("\n")
    )
  }
}

async function publishPackage(packageInfo: PublishablePackage, name: string): Promise<void> {
  const args = [process.execPath, "publish", "--tag", options.tag]
  if (options.dryRun) args.push("--dry-run")
  if (options.otp) args.push("--otp", options.otp)
  if (options.registry) args.push("--registry", options.registry)

  const proc = Bun.spawn(args, {
    cwd: join(root, packageInfo.dir),
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
    `[SixbPublish] Failed to publish ${name}.\n${reason}\n\n` +
      (output.includes("missing authentication")
        ? "Run `bunx npm login` first — `bun publish` authenticates even for --dry-run.\n"
        : "") +
      `Published so far: ${published.length > 0 ? published.join(", ") : "nothing"}\n` +
      "Fix the cause and re-run; packages already on the registry are skipped."
  )
}

/**
 * Ask the registry directly rather than trusting a local marker, so a run interrupted anywhere —
 * including between the registry write and this process exiting — resumes correctly.
 */
async function isAlreadyPublished(name: string, target: string): Promise<boolean> {
  const registry = (options.registry ?? "https://registry.npmjs.org").replace(/\/+$/, "")
  const response = await fetch(`${registry}/${encodeURIComponent(name)}`, {
    headers: { accept: "application/vnd.npm.install-v1+json" },
  })

  if (response.status === 404) return false
  if (!response.ok) {
    throw new Error(`[SixbPublish] Could not query the registry for ${name}: ${response.status}`)
  }

  const body = (await response.json()) as { versions?: Record<string, unknown> }
  return Boolean(body.versions?.[target])
}

interface PublishOptions {
  readonly dryRun: boolean
  readonly tag: string
  readonly otp?: string
  readonly registry?: string
}

function parseOptions(argv: string[]): PublishOptions {
  const values = new Map<string, string>()
  let dryRun = false

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (arg === "--dry-run") {
      dryRun = true
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
        "[--dry-run] [--tag <tag>] [--otp <code>] [--registry <url>]"
    )
  }

  const otp = values.get("--otp")
  const registry = values.get("--registry")
  return {
    dryRun,
    tag: values.get("--tag") ?? "latest",
    ...(otp ? { otp } : {}),
    ...(registry ? { registry } : {}),
  }
}
