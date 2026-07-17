import type { Client as SshClient } from "ssh2"

const BUN_NATIVE_ADDON_PATH = "/__sixb_sftp__/native-addon-disabled.js"
const SSH2_NATIVE_ADDON_FILTER = /(?:^|[/\\])(?:sshcrypto|cpufeatures)[.]node$/

let ssh2ModulePromise: Promise<typeof import("ssh2")> | undefined
let bunFallbackRegistered = false

/** Create a raw ssh2 client with the same runtime compatibility guarantees as the SFTP adapter. */
export async function createSshClient(): Promise<SshClient> {
  const { Client } = await loadSsh2()
  return new Client()
}

function loadSsh2(): Promise<typeof import("ssh2")> {
  registerBunNativeFallback()
  ssh2ModulePromise ??= import("ssh2")
  return ssh2ModulePromise
}

function registerBunNativeFallback(): void {
  if (typeof Bun === "undefined" || bunFallbackRegistered) {
    return
  }

  Bun.plugin({
    name: "sixb-sftp-ssh2-js-crypto",
    setup(builder) {
      builder.onResolve({ filter: SSH2_NATIVE_ADDON_FILTER }, (args) => {
        if (!isSsh2OptionalNativeAddon(args.path, args.importer)) {
          return
        }

        return {
          path: BUN_NATIVE_ADDON_PATH,
          namespace: "file",
        }
      })

      builder.onLoad(
        { filter: /^\/__sixb_sftp__\/native-addon-disabled[.]js$/, namespace: "file" },
        () => ({
          contents:
            'throw new Error("[SixbSftp] Optional ssh2 native addons are disabled under Bun.")',
          loader: "js",
        })
      )
    },
  })

  bunFallbackRegistered = true
}

function isSsh2OptionalNativeAddon(path: string, importer: string): boolean {
  const normalizedPath = path.replaceAll("\\", "/")
  const normalizedImporter = importer.replaceAll("\\", "/")

  return (
    (normalizedPath.endsWith("/sshcrypto.node") &&
      normalizedImporter.endsWith("/ssh2/lib/protocol/crypto.js")) ||
    (normalizedPath.endsWith("/cpufeatures.node") &&
      normalizedImporter.endsWith("/cpu-features/lib/index.js"))
  )
}
