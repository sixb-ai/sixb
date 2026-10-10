/**
 * Turn what someone typed into an API base URL. A bare host gets https, except a local one
 * (`localhost`, an IP address, `*.local`), which gets http the way a development server serves.
 */
export function normalizeWorkspaceAddress(input: string): string {
  const address = input.trim()
  if (!address) throw new Error("Enter your workspace address.")

  const absolute = /^[a-z][a-z\d+.-]*:\/\//i.test(address)
  let url: URL
  try {
    url = new URL(absolute ? address : `${isLocalHost(address) ? "http" : "https"}://${address}`)
  } catch {
    throw new Error("That doesn't look like a workspace address.")
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("A workspace address starts with http:// or https://.")
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`
}

function isLocalHost(address: string): boolean {
  const host = address.split(/[/:]/, 1)[0]?.toLowerCase() ?? ""
  return host === "localhost" || /^\d+\.\d+\.\d+\.\d+$/.test(host) || host.endsWith(".local")
}

/** The host to show for a workspace, such as `acme-api.sixb.app`. */
export function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).host
  } catch {
    return baseUrl
  }
}
