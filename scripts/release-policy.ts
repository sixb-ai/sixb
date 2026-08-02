/**
 * The 0.0.x line is public for testing, but is not the default install line. Keeping this rule in
 * the publisher ensures every preview release goes through the one documented `next` channel.
 */
export function isPreviewRelease(version: string): boolean {
  const [major, minor] = version.split(".")
  return major === "0" && minor === "0"
}

export function assertReleaseTagAllowed(version: string, tag: string): void {
  if (!isPreviewRelease(version) || tag === "next") return

  throw new Error(
    `[SixbPublish] ${version} is a preview release and cannot be published to "${tag}". ` +
      "Use `--tag next`; `latest` is reserved for 0.1.0 and later."
  )
}
