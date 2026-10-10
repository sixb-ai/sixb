export function isImage(mediaType: string | undefined): boolean {
  return mediaType?.startsWith("image/") ?? false
}

/**
 * The filename to upload a picked file under. Expo percent-encodes the filename it sends and the
 * API keeps the name as sent, so a space would come back as "%20". This keeps only characters that
 * encoding leaves alone.
 */
export function uploadName(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "file"
}

/** Where a saved message's file is served, for an image to load or a file to open. */
export function messageFileUrl(
  baseUrl: string,
  message: { readonly threadId: string; readonly id: string },
  partIndex: number
): string {
  const params = new URLSearchParams({ path: `/parts/${partIndex}/fileRef`, disposition: "inline" })
  return `${baseUrl}/api/agent-threads/${encodeURIComponent(message.threadId)}/messages/${encodeURIComponent(message.id)}/files/content?${params}`
}
