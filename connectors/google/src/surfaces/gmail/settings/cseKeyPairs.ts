import type { GoogleHttp } from "../../../http"
import { listAllPages } from "../../../pagination"
import type {
  CseKeyPair,
  CseKeyPairCreateOptions,
  CseListOptions,
  ListCseKeyPairsResponse,
} from "../../../types/gmail"
import { gmailCollectionPath, gmailResourcePath } from "../paths"

const COLLECTION = "settings/cse/keypairs"

export interface GmailCseKeyPairsResource {
  list(userId: string, options?: CseListOptions): Promise<ListCseKeyPairsResponse>
  listAll(userId: string, options?: CseListOptions): AsyncIterable<CseKeyPair>
  get(userId: string, keyPairId: string): Promise<CseKeyPair>
  create(
    userId: string,
    keyPair: CseKeyPair,
    options?: CseKeyPairCreateOptions
  ): Promise<CseKeyPair>
  enable(userId: string, keyPairId: string): Promise<CseKeyPair>
  disable(userId: string, keyPairId: string): Promise<CseKeyPair>
  /** Permanently delete a key pair that has been disabled for more than 30 days. */
  obliterate(userId: string, keyPairId: string): Promise<void>
}

export function gmailCseKeyPairsResource(http: GoogleHttp): GmailCseKeyPairsResource {
  const resource: GmailCseKeyPairsResource = {
    list(userId, options) {
      return http.json<ListCseKeyPairsResponse>(
        "gmail",
        "GET",
        gmailCollectionPath(userId, COLLECTION),
        { query: options }
      )
    },
    listAll(userId, options) {
      return listAllPages<ListCseKeyPairsResponse, CseKeyPair>(
        (pageToken) => resource.list(userId, { ...options, pageToken }),
        (page) => page.cseKeyPairs,
        options?.pageToken
      )
    },
    get(userId, keyPairId) {
      return http.json<CseKeyPair>(
        "gmail",
        "GET",
        gmailResourcePath(userId, COLLECTION, keyPairId, "keyPairId")
      )
    },
    create(userId, keyPair, options) {
      return http.json<CseKeyPair>("gmail", "POST", gmailCollectionPath(userId, COLLECTION), {
        query: options,
        body: keyPair,
      })
    },
    enable(userId, keyPairId) {
      return http.json<CseKeyPair>(
        "gmail",
        "POST",
        gmailResourcePath(userId, COLLECTION, keyPairId, "keyPairId", ":enable"),
        { body: {} }
      )
    },
    disable(userId, keyPairId) {
      return http.json<CseKeyPair>(
        "gmail",
        "POST",
        gmailResourcePath(userId, COLLECTION, keyPairId, "keyPairId", ":disable"),
        { body: {} }
      )
    },
    obliterate(userId, keyPairId) {
      return http.json<void>(
        "gmail",
        "POST",
        gmailResourcePath(userId, COLLECTION, keyPairId, "keyPairId", ":obliterate"),
        { body: {} }
      )
    },
  }

  return resource
}
