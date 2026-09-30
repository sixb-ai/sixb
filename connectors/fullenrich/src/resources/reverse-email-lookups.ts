import type { FullEnrichHttp } from "../http"
import { job, jobStarted } from "../response"
import type {
  FullEnrichReverseEmailLookup,
  FullEnrichReverseEmailLookupsResource,
  FullEnrichStartReverseEmailLookupRequest,
} from "../types"
import { assertJobRequest, assertNonEmpty } from "../validation"

export function reverseEmailLookupsResource(
  http: FullEnrichHttp
): FullEnrichReverseEmailLookupsResource {
  return {
    async start(request, options = {}) {
      assertStartRequest(request)
      const body = await http.request({
        operation: "reverse email lookup start",
        method: "POST",
        path: "contact/reverse/email/bulk",
        query: { silentFail: options.silentFail },
        body: request,
        idempotent: false,
        signal: options.signal,
      })
      return jobStarted("reverse email lookup start", body)
    },
    async get(lookupId, options = {}) {
      assertNonEmpty(lookupId, "lookupId")
      const body = await http.request({
        operation: "reverse email lookup read",
        method: "GET",
        path: `contact/reverse/email/bulk/${encodeURIComponent(lookupId)}`,
        idempotent: true,
        signal: options.signal,
        resultStatuses: [402],
      })
      return job<FullEnrichReverseEmailLookup>("reverse email lookup read", body)
    },
  }
}

function assertStartRequest(request: FullEnrichStartReverseEmailLookupRequest): void {
  assertJobRequest(request, "reverse email lookup")
  for (const [index, entry] of request.data.entries()) {
    assertNonEmpty(entry.email, `data[${index}].email`)
  }
}
