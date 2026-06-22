import { createTeamleaderClient } from "./client"
import type { TeamleaderConnector, TeamleaderConnectorOptions } from "./types"

export function teamleader(options: TeamleaderConnectorOptions): TeamleaderConnector {
  return {
    type: "teamleader",
    webhooks: options.webhooks,
    connect() {
      return createTeamleaderClient(options)
    },
  }
}
