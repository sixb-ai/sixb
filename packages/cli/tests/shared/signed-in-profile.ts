import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { updateConfig } from "../../src/lib/profiles"

/**
 * A config directory whose current profile is signed in the way `sixb login` leaves it, and an
 * environment that names no other credential. The access token is valid long enough that the CLI
 * never refreshes it.
 */
export async function signedInProfile(apiUrl: string, accessToken: string) {
  const root = await mkdtemp(join(tmpdir(), "sixb-cli-signed-in-"))
  await updateConfig(
    () => ({
      version: 1,
      currentProfile: "acme",
      profiles: {
        acme: {
          apiUrl,
          projectId: "acme",
          session: {
            accessToken,
            refreshToken: "sixb_rt_ses_cli.secret",
            accessExpiresAt: "2099-01-01T00:00:00.000Z",
          },
        },
      },
    }),
    { env: { XDG_CONFIG_HOME: root } }
  )

  return {
    env: {
      XDG_CONFIG_HOME: root,
      SIXB_API_URL: undefined,
      SIXB_API_PUBLIC_ORIGIN: undefined,
      SIXB_API_TOKEN: undefined,
      SIXB_TOKEN: undefined,
      SIXB_PROFILE: undefined,
    },
    cleanup: () => rm(root, { recursive: true, force: true }),
  }
}
