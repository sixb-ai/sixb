import type { GetAuthSessionResponse } from "@sixb/client"

/** Someone signed in who may open every Settings page, such as Usage and Activity. */
export const settingsManagerSession: GetAuthSessionResponse = {
  authenticated: true,
  user: { id: "usr_1", email: "morgan@example.com", displayName: "Morgan Reyes", groupIds: [] },
  access: {
    console: true,
    logs: true,
    members: true,
    serviceAccounts: true,
    usage: true,
    activity: true,
  },
  session: { id: "session-1", expiresAt: "2099-10-15T00:00:00.000Z" },
}
