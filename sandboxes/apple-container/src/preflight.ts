import { existsSync } from "node:fs"
import { release } from "node:os"

export interface AppleContainerProbe {
  readonly ok: boolean
  readonly message: string
}

export interface ProbeInput {
  readonly bin: string
  readonly platform: NodeJS.Platform
  readonly arch: NodeJS.Architecture
  /**
   * Darwin kernel major version. macOS 26 is Darwin 25; macOS 15 is Darwin 24.
   * Omit when unknown.
   */
  readonly darwinMajorVersion?: number
  hasBinary(name: string): boolean
}

const MIN_DARWIN_MAJOR_FOR_MACOS_26 = 25

export function evaluateAppleContainer(input: ProbeInput): AppleContainerProbe {
  if (input.platform !== "darwin") {
    return { ok: false, message: "Apple Container requires macOS on Apple silicon" }
  }
  if (input.arch !== "arm64") {
    return { ok: false, message: "Apple Container requires Apple silicon (arm64)" }
  }
  if (
    input.darwinMajorVersion !== undefined &&
    input.darwinMajorVersion < MIN_DARWIN_MAJOR_FOR_MACOS_26
  ) {
    return {
      ok: false,
      message: "Apple Container requires macOS 26 or newer",
    }
  }
  if (!input.hasBinary(input.bin)) {
    return { ok: false, message: `Apple Container CLI binary '${input.bin}' not found` }
  }
  return { ok: true, message: "Apple Container ready" }
}

export function probeAppleContainer(bin: string): AppleContainerProbe {
  return evaluateAppleContainer({
    bin,
    platform: process.platform,
    arch: process.arch,
    darwinMajorVersion: process.platform === "darwin" ? darwinMajorVersion() : undefined,
    hasBinary: (name) => (name.includes("/") ? existsSync(name) : Boolean(Bun.which(name))),
  })
}

function darwinMajorVersion(): number | undefined {
  const major = Number.parseInt(release().split(".")[0] ?? "", 10)
  return Number.isInteger(major) ? major : undefined
}
