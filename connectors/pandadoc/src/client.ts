import type { PandaDocHttp } from "./http"
import { betaDocumentsResource } from "./resources/beta-documents"
import { contactsResource } from "./resources/contacts"
import { contentLibraryItemsResource } from "./resources/content-library-items"
import { documentAttachmentsResource } from "./resources/document-attachments"
import { documentAuditTrailResource } from "./resources/document-audit-trail"
import { documentAutoRemindersResource } from "./resources/document-auto-reminders"
import { documentDsvResource } from "./resources/document-dsv"
import { documentFieldsResource } from "./resources/document-fields"
import { documentLinkedObjectsResource } from "./resources/document-linked-objects"
import { documentRecipientsResource } from "./resources/document-recipients"
import { documentSectionsResource } from "./resources/document-sections"
import { documentSettingsResource } from "./resources/document-settings"
import { documentsResource } from "./resources/documents"
import { foldersResource } from "./resources/folders"
import { formsResource } from "./resources/forms"
import { logsResource } from "./resources/logs"
import { membersResource } from "./resources/members"
import { notaryResource } from "./resources/notary"
import { productCatalogResource } from "./resources/product-catalog"
import { quotesResource } from "./resources/quotes"
import { smsOptOutsResource } from "./resources/sms-opt-outs"
import { templatesResource } from "./resources/templates"
import { usersResource } from "./resources/users"
import { webhookEventsResource } from "./resources/webhook-events"
import { webhookSubscriptionsResource } from "./resources/webhook-subscriptions"
import { workspacesResource } from "./resources/workspaces"
import type { PandaDocClient } from "./types"

export function createPandaDocClient(http: PandaDocHttp): PandaDocClient {
  return {
    documents: documentsResource(http),
    documentFields: documentFieldsResource(http),
    documentLinkedObjects: documentLinkedObjectsResource(http),
    documentRecipients: documentRecipientsResource(http),
    documentAutoReminders: documentAutoRemindersResource(http),
    documentAttachments: documentAttachmentsResource(http),
    documentAuditTrail: documentAuditTrailResource(http),
    documentSettings: documentSettingsResource(http),
    documentSections: documentSectionsResource(http),
    documentDsv: documentDsvResource(http),
    templates: templatesResource(http),
    contacts: contactsResource(http),
    contentLibraryItems: contentLibraryItemsResource(http),
    forms: formsResource(http),
    members: membersResource(http),
    folders: foldersResource(http),
    logs: logsResource(http),
    notary: notaryResource(http),
    productCatalog: productCatalogResource(http),
    quotes: quotesResource(http),
    workspaces: workspacesResource(http),
    users: usersResource(http),
    smsOptOuts: smsOptOutsResource(http),
    betaDocuments: betaDocumentsResource(http),
    webhookSubscriptions: webhookSubscriptionsResource(http),
    webhookEvents: webhookEventsResource(http),
  }
}
