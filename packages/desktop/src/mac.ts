import { randomBytes } from "node:crypto"
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import { run } from "./run"

/** What signs a macOS build: a Developer ID certificate, and the key that notarizes it. */
export interface AppleSigning {
  /** The certificate's SHA-1 fingerprint, which names it to `codesign` beyond doubt. */
  readonly identity: string
  /** The keychain it's in: a temporary one for `APPLE_CERTIFICATE`, else the search list's. */
  readonly keychain?: string
  readonly notary: { readonly key: string; readonly keyId: string; readonly issuer: string }
  /** Deletes the temporary keychain and key file, and puts the keychain search list back. */
  dispose(): Promise<void>
}

/**
 * The runner is Bun, whose JavaScript engine writes machine code as it runs. Under the hardened
 * runtime that notarization requires, it needs these, which Bun documents for compiled programs.
 */
export const RUNNER_ENTITLEMENTS = [
  "com.apple.security.cs.allow-jit",
  "com.apple.security.cs.allow-unsigned-executable-memory",
  "com.apple.security.cs.disable-library-validation",
] as const

const NOTARY_VARIABLES = ["APPLE_API_KEY", "APPLE_API_KEY_ID", "APPLE_API_ISSUER"] as const

/**
 * Reads the Apple credentials from the environment. None set: null, and the build is unsigned.
 * `APPLE_CERTIFICATE` is a base64 `.p12` of the Developer ID Application certificate and its
 * private key; without it the certificate comes from the keychain, as on a Mac that has it.
 */
export async function appleSigning(
  env: Readonly<Record<string, string | undefined>> = process.env
): Promise<AppleSigning | null> {
  const set = (name: string) => Boolean(env[name]?.trim())
  if (!NOTARY_VARIABLES.some(set) && !set("APPLE_CERTIFICATE")) return null
  const missing = NOTARY_VARIABLES.filter((name) => !set(name))
  if (missing.length > 0) {
    throw new Error(
      `[SixbDesktop] Signing the macOS app needs ${missing.join(", ")} as well. Set all of ` +
        `${NOTARY_VARIABLES.join(", ")}, or no Apple variable to build it unsigned.`
    )
  }

  const dir = await mkdtemp(join(tmpdir(), "sixb-signing-"))
  const cleanups: (() => Promise<unknown>)[] = [() => rm(dir, { recursive: true, force: true })]
  const dispose = async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup().catch(() => {})
  }
  try {
    const key = await notaryKey(env.APPLE_API_KEY as string, dir)
    const keychain = env.APPLE_CERTIFICATE?.trim()
      ? await temporaryKeychain(
          env.APPLE_CERTIFICATE.trim(),
          env.APPLE_CERTIFICATE_PASSWORD ?? "",
          dir,
          cleanups
        )
      : undefined
    return {
      identity: await developerIdentity(keychain),
      ...(keychain ? { keychain } : {}),
      notary: {
        key,
        keyId: (env.APPLE_API_KEY_ID as string).trim(),
        issuer: (env.APPLE_API_ISSUER as string).trim(),
      },
      dispose,
    }
  } catch (error) {
    await dispose()
    throw error
  }
}

/** `notarytool` reads the key from a file: `APPLE_API_KEY` is either that file or its contents. */
async function notaryKey(value: string, dir: string): Promise<string> {
  if (!value.includes("-----BEGIN")) return value.trim()
  const path = join(dir, "AuthKey.p8")
  await writeFile(path, `${value.trim()}\n`, { mode: 0o600 })
  return path
}

/**
 * A keychain of its own for the certificate, so that a CI runner, an agent and a laptop sign the
 * same way. `codesign` finds the certificate's issuers through the search list, so the keychain
 * joins it until `dispose`.
 */
async function temporaryKeychain(
  certificate: string,
  certificatePassword: string,
  dir: string,
  cleanups: (() => Promise<unknown>)[]
): Promise<string> {
  const keychain = join(dir, "signing.keychain-db")
  const password = randomBytes(24).toString("hex")
  const p12 = join(dir, "certificate.p12")
  await writeFile(p12, Buffer.from(certificate, "base64"), { mode: 0o600 })

  const security = (args: readonly string[], failure: string) => run(["security", ...args], failure)
  await security(["create-keychain", "-p", password, keychain], "Could not create a keychain.")
  cleanups.push(() => security(["delete-keychain", keychain], "Could not delete the keychain."))
  // Locks again after 6 hours instead of 5 minutes, which a notarized build can outlast.
  await security(
    ["set-keychain-settings", "-lut", "21600", keychain],
    "Could not set up the keychain."
  )
  await security(["unlock-keychain", "-p", password, keychain], "Could not unlock the keychain.")
  await security(
    ["import", p12, "-k", keychain, "-P", certificatePassword, "-T", "/usr/bin/codesign"],
    "Could not import APPLE_CERTIFICATE. It must be a base64 .p12 of the certificate and its " +
      "private key, and APPLE_CERTIFICATE_PASSWORD its password."
  )
  // Lets `codesign` use the key without a dialog, which nobody would be there to answer.
  await security(
    [
      "set-key-partition-list",
      "-S",
      "apple-tool:,apple:,codesign:",
      "-s",
      "-k",
      password,
      keychain,
    ],
    "Could not allow codesign to use the certificate."
  )

  const searchList = parseKeychainList(
    await security(["list-keychains", "-d", "user"], "Could not read the keychain search list.")
  )
  await security(
    ["list-keychains", "-d", "user", "-s", keychain, ...searchList],
    "Could not add the keychain to the search list."
  )
  cleanups.push(() =>
    security(
      ["list-keychains", "-d", "user", "-s", ...searchList],
      "Could not restore the keychain search list."
    )
  )
  return keychain
}

/** `security list-keychains` prints one quoted path a line. */
export function parseKeychainList(output: string): string[] {
  return output
    .split("\n")
    .map((line) => line.trim().replace(/^"|"$/g, ""))
    .filter(Boolean)
}

async function developerIdentity(keychain: string | undefined): Promise<string> {
  const output = await run(
    ["security", "find-identity", "-v", "-p", "codesigning", ...(keychain ? [keychain] : [])],
    "Could not look for a signing certificate."
  )
  const identity = findDeveloperIdentity(output)
  if (!identity) {
    throw new Error(
      `[SixbDesktop] No valid Developer ID Application certificate in ${
        keychain ? "APPLE_CERTIFICATE" : "your keychain"
      }. Create one at developer.apple.com, then export it with its private key as a .p12 for ` +
        "APPLE_CERTIFICATE."
    )
  }
  return identity
}

/** The first Developer ID Application identity `security find-identity -v` lists, by fingerprint. */
export function findDeveloperIdentity(output: string): string | null {
  return output.match(/^\s*\d+\)\s+([0-9A-F]{40})\s+"Developer ID Application: /m)?.[1] ?? null
}

/** Signs a file, such as the disk image, with the Developer ID certificate. */
export async function signFile(path: string, signing: AppleSigning): Promise<void> {
  await run(
    [
      "codesign",
      "--force",
      "--timestamp",
      "--sign",
      signing.identity,
      ...(signing.keychain ? ["--keychain", signing.keychain] : []),
      path,
    ],
    `Could not sign ${basename(path)}.`
  )
}

/**
 * A disk image of the app beside a shortcut to Applications, the window people drag the app
 * across to install it.
 */
export async function makeDiskImage(bundle: string, name: string, out: string): Promise<void> {
  const staging = await mkdtemp(join(tmpdir(), "sixb-dmg-"))
  try {
    // `ditto` keeps the bundle's symlinks, and with them its signature.
    await run(["ditto", bundle, join(staging, basename(bundle))], "Could not copy the app.")
    await symlink("/Applications", join(staging, "Applications"))
    // LZMA: a quarter smaller than the default compression, for half a minute more of building.
    await run(
      ["hdiutil", "create", "-volname", name, "-srcfolder", staging, "-ov", "-format", "ULMO", out],
      "Could not make the disk image.",
      { timeoutMs: 900_000 }
    )
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
}

/**
 * Has Apple notarize the disk image, which covers the app inside it, then staples the ticket to it
 * so it opens without a network check. Apple usually answers within minutes.
 */
export async function notarize(path: string, signing: AppleSigning): Promise<void> {
  const credentials = [
    "--key",
    signing.notary.key,
    "--key-id",
    signing.notary.keyId,
    "--issuer",
    signing.notary.issuer,
  ]
  const submit = Bun.spawn(
    ["xcrun", "notarytool", "submit", path, ...credentials, "--wait", "--output-format", "json"],
    { stdio: ["ignore", "pipe", "pipe"], timeout: 3_600_000 }
  )
  const [, output, errors] = await Promise.all([
    submit.exited,
    new Response(submit.stdout).text(),
    new Response(submit.stderr).text(),
  ])
  const result = parseJson(output) as { readonly id?: unknown; readonly status?: unknown } | null
  if (result?.status !== "Accepted") {
    const id = typeof result?.id === "string" ? result.id : null
    const log = id
      ? await run(
          ["xcrun", "notarytool", "log", id, ...credentials],
          "Could not read the notarization log."
        ).catch(() => "")
      : ""
    const detail = notarizationIssues(log) || errors.trim() || output.trim()
    throw new Error(
      `[SixbDesktop] Apple did not notarize the app${
        typeof result?.status === "string" ? ` (${result.status})` : ""
      }.${detail ? `\n${detail}` : ""}`
    )
  }
  await run(["xcrun", "stapler", "staple", path], "Could not staple the notarization.")
}

/** The issues a notarization log lists, one a line. */
export function notarizationIssues(log: string): string {
  const parsed = parseJson(log) as { readonly issues?: unknown } | null
  if (!Array.isArray(parsed?.issues)) return ""
  return parsed.issues
    .slice(0, 10)
    .map((issue: { readonly path?: unknown; readonly message?: unknown }) =>
      [issue.path, issue.message].filter((part) => typeof part === "string").join(": ")
    )
    .filter(Boolean)
    .join("\n")
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}
