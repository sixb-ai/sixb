import type { GoogleHttp } from "../../../http"
import type {
  AutoForwarding,
  ImapSettings,
  LanguageSettings,
  PopSettings,
  VacationSettings,
} from "../../../types/gmail"
import { gmailCollectionPath } from "../paths"
import { type GmailCseIdentitiesResource, gmailCseIdentitiesResource } from "./cseIdentities"
import { type GmailCseKeyPairsResource, gmailCseKeyPairsResource } from "./cseKeyPairs"
import { type GmailDelegatesResource, gmailDelegatesResource } from "./delegates"
import { type GmailFiltersResource, gmailFiltersResource } from "./filters"
import {
  type GmailForwardingAddressesResource,
  gmailForwardingAddressesResource,
} from "./forwardingAddresses"
import { type GmailSendAsResource, gmailSendAsResource } from "./sendAs"

export interface GmailCseResource {
  readonly identities: GmailCseIdentitiesResource
  readonly keypairs: GmailCseKeyPairsResource
}

export interface GmailSettingsResource {
  readonly forwardingAddresses: GmailForwardingAddressesResource
  readonly filters: GmailFiltersResource
  readonly delegates: GmailDelegatesResource
  readonly sendAs: GmailSendAsResource
  readonly cse: GmailCseResource
  getAutoForwarding(userId: string): Promise<AutoForwarding>
  updateAutoForwarding(userId: string, settings: AutoForwarding): Promise<AutoForwarding>
  getImap(userId: string): Promise<ImapSettings>
  updateImap(userId: string, settings: ImapSettings): Promise<ImapSettings>
  getLanguage(userId: string): Promise<LanguageSettings>
  updateLanguage(userId: string, settings: LanguageSettings): Promise<LanguageSettings>
  getPop(userId: string): Promise<PopSettings>
  updatePop(userId: string, settings: PopSettings): Promise<PopSettings>
  getVacation(userId: string): Promise<VacationSettings>
  updateVacation(userId: string, settings: VacationSettings): Promise<VacationSettings>
}

function settingPath(userId: string, name: string): string {
  return gmailCollectionPath(userId, `settings/${name}`)
}

export function gmailSettingsResource(http: GoogleHttp): GmailSettingsResource {
  return {
    forwardingAddresses: gmailForwardingAddressesResource(http),
    filters: gmailFiltersResource(http),
    delegates: gmailDelegatesResource(http),
    sendAs: gmailSendAsResource(http),
    cse: {
      identities: gmailCseIdentitiesResource(http),
      keypairs: gmailCseKeyPairsResource(http),
    },
    getAutoForwarding(userId) {
      return http.json<AutoForwarding>("gmail", "GET", settingPath(userId, "autoForwarding"))
    },
    updateAutoForwarding(userId, settings) {
      return http.json<AutoForwarding>("gmail", "PUT", settingPath(userId, "autoForwarding"), {
        body: settings,
      })
    },
    getImap(userId) {
      return http.json<ImapSettings>("gmail", "GET", settingPath(userId, "imap"))
    },
    updateImap(userId, settings) {
      return http.json<ImapSettings>("gmail", "PUT", settingPath(userId, "imap"), {
        body: settings,
      })
    },
    getLanguage(userId) {
      return http.json<LanguageSettings>("gmail", "GET", settingPath(userId, "language"))
    },
    updateLanguage(userId, settings) {
      return http.json<LanguageSettings>("gmail", "PUT", settingPath(userId, "language"), {
        body: settings,
      })
    },
    getPop(userId) {
      return http.json<PopSettings>("gmail", "GET", settingPath(userId, "pop"))
    },
    updatePop(userId, settings) {
      return http.json<PopSettings>("gmail", "PUT", settingPath(userId, "pop"), {
        body: settings,
      })
    },
    getVacation(userId) {
      return http.json<VacationSettings>("gmail", "GET", settingPath(userId, "vacation"))
    },
    updateVacation(userId, settings) {
      return http.json<VacationSettings>("gmail", "PUT", settingPath(userId, "vacation"), {
        body: settings,
      })
    },
  }
}
