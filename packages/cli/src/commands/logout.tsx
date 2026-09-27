import { writeJson } from "@sixb/cli-core"
import { signOutSixbSession } from "@sixb/client"
import { profileSessionStore, readConfig, requireProfile, updateConfig } from "../lib/profiles"
import { KeyValueResultView, renderStatic } from "../ui"

export interface LogoutCommandOptions {
  readonly profile?: string
  readonly json?: boolean
}

export async function runLogout(options: LogoutCommandOptions = {}): Promise<void> {
  const current = await readConfig()
  const name = options.profile?.trim() || current.currentProfile
  if (!name) throw new Error("[SixbCLI] No current profile to remove.")
  const stored = requireProfile(current, name)
  // End the session on the server too, so a copy of its tokens stops working.
  if (stored.session) {
    await signOutSixbSession({ baseUrl: stored.apiUrl, store: profileSessionStore(name) })
  }

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
