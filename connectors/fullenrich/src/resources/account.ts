import type { FullEnrichHttp } from "../http"
import { malformed } from "../response"
import type { FullEnrichAccountResource } from "../types"

export function accountResource(http: FullEnrichHttp): FullEnrichAccountResource {
  return {
    async credits(options = {}) {
      const body = await http.request({
        operation: "credit balance",
        method: "GET",
        path: "account/credits",
        idempotent: true,
        signal: options.signal,
      })
      if (typeof body.balance !== "number" || !Number.isFinite(body.balance)) {
        throw malformed("credit balance", "balance must be a finite number")
      }
      return { balance: body.balance }
    },
    async verifyKey(options = {}) {
      const body = await http.request({
        operation: "API key check",
        method: "GET",
        path: "account/keys/verify",
        idempotent: true,
        signal: options.signal,
      })
      if (typeof body.workspace_id !== "string" || !body.workspace_id) {
        throw malformed("API key check", "workspace_id must be a non-empty string")
      }
      return { workspace_id: body.workspace_id }
    },
  }
}
