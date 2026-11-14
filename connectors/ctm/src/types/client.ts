import type { AccountsResource, AgencyResource } from "../resources/accounts"
import type { CallsResource } from "../resources/calls"
import type {
  ContactListsResource,
  CustomFieldsResource,
  FormReactorsResource,
  LookupResource,
} from "../resources/lists"
import type { SmsResource, TextOptOutsResource } from "../resources/messages"
import type {
  BlockedNumbersResource,
  DoNotCallResource,
  ReceivingNumbersResource,
  TargetNumbersResource,
  TrackingNumbersResource,
} from "../resources/numbers"
import type { ReportsResource } from "../resources/reports"
import type {
  GeoRoutersResource,
  QueuesResource,
  SchedulesResource,
  SmartRoutersResource,
  SourcesResource,
  TriggersResource,
  VoiceMenusResource,
} from "../resources/routing"
import type { AgentsResource, UserGroupsResource, UsersResource } from "../resources/team"
import type { ChangeNotificationsResource, WebhooksResource } from "../resources/webhooks"
import type { CtmId } from "./common"

/** One account's resources, grouped as in CTM. */
export interface CtmAccountClient {
  /** The call log: calls, texts and forms, with transcripts, recordings and sales. */
  readonly calls: CallsResource
  readonly sms: SmsResource
  readonly textOptOuts: TextOptOutsResource

  readonly trackingNumbers: TrackingNumbersResource
  readonly receivingNumbers: ReceivingNumbersResource
  readonly targetNumbers: TargetNumbersResource
  readonly doNotCall: DoNotCallResource
  readonly blockedNumbers: BlockedNumbersResource

  readonly sources: SourcesResource
  readonly queues: QueuesResource
  readonly schedules: SchedulesResource
  readonly voiceMenus: VoiceMenusResource
  readonly smartRouters: SmartRoutersResource
  readonly geoRouters: GeoRoutersResource
  readonly triggers: TriggersResource

  readonly users: UsersResource
  readonly userGroups: UserGroupsResource
  readonly agents: AgentsResource

  readonly customFields: CustomFieldsResource
  readonly formReactors: FormReactorsResource
  readonly contactLists: ContactListsResource
  /** Search objects by type, and the only list of the account's tags. */
  readonly lookup: LookupResource
  readonly reports: ReportsResource

  readonly webhooks: WebhooksResource
  readonly changeNotifications: ChangeNotificationsResource
}

/**
 * Typed CTM client. Its resources address the connector's `accountId`; `account(id)` addresses
 * another account an agency key reaches.
 */
export interface CtmClient extends CtmAccountClient {
  readonly accounts: AccountsResource
  readonly agency: AgencyResource
  account(accountId: CtmId): CtmAccountClient
}
