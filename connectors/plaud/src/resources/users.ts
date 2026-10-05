import type { PlaudHttp } from "../http"
import type { PlaudClient, PlaudUser } from "../types"
import { isRecord } from "../validation"

export function createUsersResource(http: PlaudHttp): PlaudClient["users"] {
  return {
    async current(options) {
      const data = await http.get("open/third-party/users/current", options?.signal)
      if (
        !isRecord(data) ||
        typeof data.id !== "string" ||
        !data.id ||
        typeof data.email !== "string" ||
        typeof data.nickname !== "string" ||
        (data.avatar !== null && typeof data.avatar !== "string")
      )
        throw new Error("[SixbPlaud] Invalid user response.")
      return data as PlaudUser
    },
  }
}
