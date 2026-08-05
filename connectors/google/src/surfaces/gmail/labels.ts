import type { GoogleHttp } from "../../http"
import type { Label, ListLabelsResponse } from "../../types/gmail"
import { gmailCollectionPath, gmailResourcePath } from "./paths"

export interface GmailLabelsResource {
  list(userId: string): Promise<ListLabelsResponse>
  get(userId: string, id: string): Promise<Label>
  create(userId: string, label: Label): Promise<Label>
  update(userId: string, id: string, label: Label): Promise<Label>
  patch(userId: string, id: string, label: Partial<Label>): Promise<Label>
  delete(userId: string, id: string): Promise<void>
}

export function gmailLabelsResource(http: GoogleHttp): GmailLabelsResource {
  return {
    list(userId) {
      return http.json<ListLabelsResponse>("gmail", "GET", gmailCollectionPath(userId, "labels"))
    },
    get(userId, id) {
      return http.json<Label>("gmail", "GET", gmailResourcePath(userId, "labels", id, "labelId"))
    },
    create(userId, label) {
      return http.json<Label>("gmail", "POST", gmailCollectionPath(userId, "labels"), {
        body: label,
      })
    },
    update(userId, id, label) {
      return http.json<Label>("gmail", "PUT", gmailResourcePath(userId, "labels", id, "labelId"), {
        body: label,
      })
    },
    patch(userId, id, label) {
      return http.json<Label>(
        "gmail",
        "PATCH",
        gmailResourcePath(userId, "labels", id, "labelId"),
        { body: label }
      )
    },
    delete(userId, id) {
      return http.json<void>("gmail", "DELETE", gmailResourcePath(userId, "labels", id, "labelId"))
    },
  }
}
