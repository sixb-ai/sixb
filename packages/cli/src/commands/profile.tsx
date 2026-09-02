import { writeJson } from "@sixb/cli-core"
import { readConfig, requireProfile, updateConfig } from "../lib/profiles"
import { KeyValueResultView, renderStatic, TableResultView } from "../ui"

export interface ProfileCommandOptions {
  readonly action?: string
  readonly name?: string
  readonly json?: boolean
}

export async function runProfile(options: ProfileCommandOptions = {}): Promise<void> {
  const action = options.action
  if (action === "list") return listProfiles(options)
  if (action === "show") return showProfile(options)
  if (action === "use") return selectProfile(options)
  throw new Error("Usage: sixb profile <list|show|use> [name]")
}

async function listProfiles(options: ProfileCommandOptions): Promise<void> {
  const config = await readConfig()
  const profiles = Object.entries(config.profiles)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, profile]) => ({
      name,
      current: name === config.currentProfile,
      projectId: profile.projectId,
      apiUrl: profile.apiUrl,
      authenticated: Boolean(profile.token),
    }))

  if (options.json) {
    writeJson({ currentProfile: config.currentProfile ?? null, profiles })
    return
  }

  await renderStatic(
    <TableResultView
      title="Sixb profiles"
      headers={["Current", "Profile", "Project", "API", "Token"]}
      rows={profiles.map((profile) => [
        profile.current ? "*" : "",
        profile.name,
        profile.projectId,
        profile.apiUrl,
        profile.authenticated ? "yes" : "no",
      ])}
      emptyMessage="No profiles. Run `sixb login <api-url>`."
    />
  )
}

async function showProfile(options: ProfileCommandOptions): Promise<void> {
  const config = await readConfig()
  const name = options.name?.trim() || config.currentProfile
  if (!name) throw new Error("[SixbCLI] No current profile. Run `sixb login <api-url>`.")
  const profile = requireProfile(config, name)
  const result = {
    name,
    current: name === config.currentProfile,
    projectId: profile.projectId,
    apiUrl: profile.apiUrl,
    authenticated: Boolean(profile.token),
  }

  if (options.json) {
    writeJson(result)
    return
  }

  await renderStatic(
    <KeyValueResultView
      title={`Profile "${name}"`}
      items={[
        { label: "Current", value: result.current ? "yes" : "no" },
        { label: "Project", value: result.projectId },
        { label: "API", value: result.apiUrl },
        { label: "Stored token", value: result.authenticated ? "yes" : "no" },
      ]}
    />
  )
}

async function selectProfile(options: ProfileCommandOptions): Promise<void> {
  const name = options.name?.trim()
  if (!name) throw new Error("Usage: sixb profile use <name>")
  await updateConfig((config) => {
    requireProfile(config, name)
    return { ...config, currentProfile: name }
  })

  if (options.json) {
    writeJson({ currentProfile: name })
    return
  }
  await renderStatic(
    <KeyValueResultView
      title={`Using profile "${name}"`}
      items={[{ label: "Profile", value: name }]}
    />
  )
}
