import { writeJson } from "@sixb/cli-core"
import { readConfig, requireProfile, updateConfig } from "../lib/profiles"
import { keyValueResultView, renderStatic, tableResultView } from "../ui"
import { canRunLive } from "../ui/live/can-run-live"
import { glyph, tone } from "../ui/theme"

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
      authenticated: Boolean(profile.token ?? profile.session),
    }))

  if (options.json) {
    writeJson({ currentProfile: config.currentProfile ?? null, profiles })
    return
  }

  await renderStatic(
    tableResultView({
      title: "Sixb profiles",
      headers: ["", "Profile", "Project", "API", "Token"],
      rows: profiles.map((profile) => [
        profile.current ? tone.blue(glyph.live) : " ",
        profile.name,
        profile.projectId,
        profile.apiUrl,
        profile.authenticated ? "yes" : "no",
      ]),
      emptyMessage: "No profiles. Run `sixb login <api-url>`.",
    })
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
    authenticated: Boolean(profile.token ?? profile.session),
  }

  if (options.json) {
    writeJson(result)
    return
  }

  await renderStatic(
    keyValueResultView({
      title: `Profile "${name}"`,
      items: [
        { label: "Current", value: result.current ? "yes" : "no" },
        { label: "Project", value: result.projectId },
        { label: "API", value: result.apiUrl },
        { label: "Stored token", value: result.authenticated ? "yes" : "no" },
      ],
    })
  )
}

async function selectProfile(options: ProfileCommandOptions): Promise<void> {
  const name = options.name?.trim() || (canRunLive() && !options.json ? await pickProfile() : "")
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
    keyValueResultView({
      title: `Using profile "${name}"`,
      items: [{ label: "Profile", value: name }],
    })
  )
}

/** Lets the person pick a saved profile; `""` when there is none to pick. */
async function pickProfile(): Promise<string> {
  const config = await readConfig()
  const names = Object.keys(config.profiles).sort((left, right) => left.localeCompare(right))
  if (names.length === 0) return ""
  const { promptSelect } = await import("../ui/live/prompt")
  return promptSelect({
    command: "profile use",
    label: "Profile",
    choices: names.map((name) => ({
      label: name,
      value: name,
      detail: `${config.profiles[name]?.apiUrl ?? ""}${name === config.currentProfile ? "  (current)" : ""}`,
    })),
    initial: Math.max(0, names.indexOf(config.currentProfile ?? "")),
  })
}
