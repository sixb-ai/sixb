import { readdir } from "node:fs/promises"
import { join, relative } from "node:path"

const MEDIA_TYPES: Readonly<Record<string, string>> = {
  css: "text/css",
  html: "text/html",
  json: "application/json",
  svg: "image/svg+xml",
  webp: "image/webp",
}

/** Every file under `directory`, at its path inside it, as an artifact holds it. */
export async function folderFiles(
  directory: string
): Promise<readonly { readonly path: string; readonly body: Blob; readonly mediaType: string }[]> {
  const entries = await readdir(directory, { recursive: true, withFileTypes: true })

  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => {
      const absolute = join(entry.parentPath, entry.name)
      const extension = entry.name.slice(entry.name.lastIndexOf(".") + 1)

      return {
        path: relative(directory, absolute),
        body: Bun.file(absolute),
        mediaType: MEDIA_TYPES[extension] ?? "application/octet-stream",
      }
    })
    .sort((a, b) => a.path.localeCompare(b.path))
}
