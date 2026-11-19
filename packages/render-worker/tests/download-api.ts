import type { BlobStorage, Storage } from "@sixb/core"
import { FILE_DOWNLOAD_ROUTE_PREFIX, resolveFileDownload } from "@sixb/core/internal/blob-storage"
import { setApiPublicOrigin } from "@sixb/core/internal/runtime"

/**
 * The API's download route, as far as a sandbox's curl reaches it: the file a token names, cut
 * short when `truncate` says so, as a connection that drops would.
 */
export function startDownloadApi(
  host: { readonly id: string; readonly storage: Storage; readonly blobStorage: BlobStorage },
  options: { readonly truncate?: boolean } = {}
) {
  const served: { readonly token: string; readonly blobId: string }[] = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const { pathname } = new URL(request.url)
      const token = pathname.slice(FILE_DOWNLOAD_ROUTE_PREFIX.length)
      const file = pathname.startsWith(FILE_DOWNLOAD_ROUTE_PREFIX)
        ? await resolveFileDownload(host, token)
        : null
      if (!file) return new Response("Not found", { status: 404 })
      served.push({ token, blobId: file.blobId })
      const bytes = new Uint8Array(
        await new Response(await host.blobStorage.open(file.blobId)).arrayBuffer()
      )
      return new Response(options.truncate ? bytes.subarray(0, bytes.byteLength - 1) : bytes)
    },
  })
  const origin = `http://127.0.0.1:${server.port}`
  setApiPublicOrigin(host, origin)
  return { origin, served, close: () => server.stop(true) }
}
