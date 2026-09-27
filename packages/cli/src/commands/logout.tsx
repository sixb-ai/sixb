import { writeJson } from "@sixb/cli-core"
import {
  readConfig,
  requireProfile,
  resolveProfile,
  SessionEndedError,
  updateConfig,
} from "../lib/profiles"
import { KeyValueResultView, renderStatic } from "../ui"

export interface LogoutCommandOptions {
  readonly profile?: string
  readonly json?: boolean
}

export async function runLogout(options: LogoutCommandOptions = {}): Promise<void> {
  const current = await readConfig()
  const name = options.profile?.trim() || current.currentProfile
  if (!name) throw new Error("[SixbCLI] No current profile to remove.")
  if (requireProfile(current, name).session) await signOut(name)

  await updateConfig((config) => {
    const profiles = { ...config.profiles }
    delete profiles[name]
    return {
      version: 1,
      ...(config.currentProfile !== name ? { currentProfile: config.currentProfile } : {}),
      profiles,
    }
  })

  if (options.json) {
    writeJson({ removedProfile: name })
    return
  }
  await renderStatic(
    <KeyValueResultView
      title={`Removed profile "${name}"`}
      items={[{ label: "Profile", value: name }]}
    />
  )
}

// End the session on the server too, so a copy of its tokens stops working. A session that has
// already ended leaves nothing to revoke.
async function signOut(profile: string): Promise<void> {
  let resolved: Awaited<ReturnType<typeof resolveProfile>>
  try {
    resolved = await resolveProfile({ profile })
  } catch (error) {
    if (error instanceof SessionEndedError) return
    throw error
  }
  const response = await fetch(`${resolved.apiUrl}/api/auth/sign-out`, {
    method: "POST",
    headers: { authorization: `Bearer ${resolved.token}` },
  })
  if (!response.ok) {
    throw new Error(
      `[SixbCLI] Signing out of profile '${profile}' failed with HTTP ${response.status}.`
    )
  }
}
