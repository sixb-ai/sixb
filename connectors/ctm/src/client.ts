import { CtmConfigurationError } from "./errors"
import type { CtmHttp } from "./http"
import { accountsResource, agencyResource } from "./resources/accounts"
import { callsResource } from "./resources/calls"
import {
  contactListsResource,
  customFieldsResource,
  formReactorsResource,
  lookupResource,
} from "./resources/lists"
import { smsResource, textOptOutsResource } from "./resources/messages"
import {
  blockedNumbersResource,
  doNotCallResource,
  receivingNumbersResource,
  targetNumbersResource,
  trackingNumbersResource,
} from "./resources/numbers"
import { reportsResource } from "./resources/reports"
import {
  geoRoutersResource,
  queuesResource,
  schedulesResource,
  smartRoutersResource,
  sourcesResource,
  triggersResource,
  voiceMenusResource,
} from "./resources/routing"
import type { CtmAccountPath } from "./resources/shared"
import { agentsResource, userGroupsResource, usersResource } from "./resources/team"
import { changeNotificationsResource, webhooksResource } from "./resources/webhooks"
import type { CtmAccountClient, CtmClient, CtmId } from "./types"
import { pathId } from "./validation"

export function createCtmClient(http: CtmHttp, accountId: CtmId | undefined): CtmClient {
  return {
    ...createCtmAccountClient(http, accountPath(accountId)),
    accounts: accountsResource(http),
    agency: agencyResource(http),

    account(otherAccountId) {
      return createCtmAccountClient(http, accountPath(otherAccountId))
    },
  }
}

function createCtmAccountClient(http: CtmHttp, at: CtmAccountPath): CtmAccountClient {
  return {
    calls: callsResource(http, at),
    sms: smsResource(http, at),
    textOptOuts: textOptOutsResource(http, at),

    trackingNumbers: trackingNumbersResource(http, at),
    receivingNumbers: receivingNumbersResource(http, at),
    targetNumbers: targetNumbersResource(http, at),
    doNotCall: doNotCallResource(http, at),
    blockedNumbers: blockedNumbersResource(http, at),

    sources: sourcesResource(http, at),
    queues: queuesResource(http, at),
    schedules: schedulesResource(http, at),
    voiceMenus: voiceMenusResource(http, at),
    smartRouters: smartRoutersResource(http, at),
    geoRouters: geoRoutersResource(http, at),
    triggers: triggersResource(http, at),

    users: usersResource(http, at),
    userGroups: userGroupsResource(http, at),
    agents: agentsResource(http, at),

    customFields: customFieldsResource(http, at),
    formReactors: formReactorsResource(http, at),
    contactLists: contactListsResource(http, at),
    lookup: lookupResource(http, at),
    reports: reportsResource(http, at),

    webhooks: webhooksResource(http, at),
    changeNotifications: changeNotificationsResource(http, at),
  }
}

/**
 * Paths under one account. Without an account, every account resource fails on its first request
 * and names the two ways to give one, while `accounts` and `agency` keep working.
 */
function accountPath(accountId: CtmId | undefined): CtmAccountPath {
  if (accountId === undefined) {
    return () => {
      throw new CtmConfigurationError(
        "[SixbCtm] No account to address. Pass `accountId` to `ctm()`, or use `client.account(id)`."
      )
    }
  }

  const id = pathId(accountId, "accountId", CtmConfigurationError)

  return (suffix) => `accounts/${id}/${suffix}`
}
