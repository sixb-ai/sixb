export const context = {
  projectId: "test",
  connectorId: "plaud",
  signal: new AbortController().signal,
  connectionId: "connection",
  account: { id: "user", label: "Example" },
  tokenSource: {
    async get() {
      return { accessToken: "access", invalidate() {} }
    },
  },
}
export const contentHost = "prod-plaud-content-storage.s3-accelerate.amazonaws.com"
export const recording = (id = "r1") => ({
  id,
  name: "Weekly sync",
  created_at: "2026-10-01T09:00:00",
  start_at: "2026-10-01T09:00:00Z",
  duration: 60_000,
  serial_number: null,
})
export const details = (extra: Record<string, unknown> = {}) => ({
  ...recording(),
  presigned_url: `https://${contentHost}/audio?signature=secret`,
  source_list: [],
  note_list: [],
  ...extra,
})
export const block = (type = "transaction", content = "") => ({
  data_id: "b1",
  data_type: type,
  data_title: "Transcript",
  data_content: content,
  data_link: `https://${contentHost}/${type}?signature=secret`,
})
export function json(value: unknown, status = 200) {
  return Response.json(value, { status })
}
export function mockFetch(fn: (url: URL, init: RequestInit) => Promise<Response> | Response) {
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
    Promise.resolve(fn(new URL(String(input)), init ?? {}))) as typeof fetch
}
