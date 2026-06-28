import type { BetaDocumentsResource } from "../resources/beta-documents"
import type { ContactsResource } from "../resources/contacts"
import type { ContentLibraryItemsResource } from "../resources/content-library-items"
import type { DocumentAttachmentsResource } from "../resources/document-attachments"
import type { DocumentAuditTrailResource } from "../resources/document-audit-trail"
import type { DocumentAutoRemindersResource } from "../resources/document-auto-reminders"
import type { DocumentDsvResource } from "../resources/document-dsv"
import type { DocumentFieldsResource } from "../resources/document-fields"
import type { DocumentLinkedObjectsResource } from "../resources/document-linked-objects"
import type { DocumentRecipientsResource } from "../resources/document-recipients"
import type { DocumentSectionsResource } from "../resources/document-sections"
import type { DocumentSettingsResource } from "../resources/document-settings"
import type { DocumentsResource } from "../resources/documents"
import type { FoldersResource } from "../resources/folders"
import type { FormsResource } from "../resources/forms"
import type { LogsResource } from "../resources/logs"
import type { MembersResource } from "../resources/members"
import type { NotaryResource } from "../resources/notary"
import type { ProductCatalogResource } from "../resources/product-catalog"
import type { QuotesResource } from "../resources/quotes"
import type { SmsOptOutsResource } from "../resources/sms-opt-outs"
import type { TemplatesResource } from "../resources/templates"
import type { UsersResource } from "../resources/users"
import type { WebhookEventsResource } from "../resources/webhook-events"
import type { WebhookSubscriptionsResource } from "../resources/webhook-subscriptions"
import type { WorkspacesResource } from "../resources/workspaces"
import type { PandaDocConnectorOptions } from "./common"

export interface PandaDocClient {
  readonly documents: DocumentsResource
  readonly documentFields: DocumentFieldsResource
  readonly documentLinkedObjects: DocumentLinkedObjectsResource
  readonly documentRecipients: DocumentRecipientsResource
  readonly documentAutoReminders: DocumentAutoRemindersResource
  readonly documentAttachments: DocumentAttachmentsResource
  readonly documentAuditTrail: DocumentAuditTrailResource
  readonly documentSettings: DocumentSettingsResource
  readonly documentSections: DocumentSectionsResource
  readonly documentDsv: DocumentDsvResource
  readonly templates: TemplatesResource
  readonly contacts: ContactsResource
  readonly contentLibraryItems: ContentLibraryItemsResource
  readonly forms: FormsResource
  readonly members: MembersResource
  readonly folders: FoldersResource
  readonly logs: LogsResource
  readonly notary: NotaryResource
  readonly productCatalog: ProductCatalogResource
  readonly quotes: QuotesResource
  readonly workspaces: WorkspacesResource
  readonly users: UsersResource
  readonly smsOptOuts: SmsOptOutsResource
  readonly betaDocuments: BetaDocumentsResource
  readonly webhookSubscriptions: WebhookSubscriptionsResource
  readonly webhookEvents: WebhookEventsResource
}

export type PandaDocClientOptions = PandaDocConnectorOptions
