/**
 * Where the deployment serves its desktop app: the app's origin, under the prefix its server keeps
 * for itself. The shell's updater and the web app's download link both read from here.
 */
export const RELEASE_PATH = "/__sixb/desktop"

/** The systems a release is made for. */
export type ReleasePlatform = "darwin"

/** What people download, by system. */
export const INSTALLER: Readonly<Record<ReleasePlatform, string>> = { darwin: "install.dmg" }

/** The macOS update feed, in the format Electron's updater reads with `serverType: "json"`. */
export const MAC_FEED = "releases.json"

/** The archive the app updates itself from. */
export function macUpdateArchive(version: string): string {
  return `app-${version}.zip`
}

/** Where a release's file is served, from the app's URL. */
export function releaseUrl(appUrl: string, platform: ReleasePlatform, file: string): string {
  return new URL(`${RELEASE_PATH}/${platform}/${file}`, appUrl).href
}

/**
 * The feed lists only the current release: an app on any older version updates straight to it, and
 * the folder holds no other.
 */
export function renderMacFeed(input: {
  readonly appUrl: string
  readonly version: string
  readonly publishedAt: Date
}): string {
  const update = {
    version: input.version,
    name: input.version,
    notes: "",
    pub_date: input.publishedAt.toISOString(),
    url: releaseUrl(input.appUrl, "darwin", macUpdateArchive(input.version)),
  }
  const feed = {
    currentRelease: input.version,
    releases: [{ version: input.version, updateTo: update }],
  }
  return `${JSON.stringify(feed, null, 2)}\n`
}
