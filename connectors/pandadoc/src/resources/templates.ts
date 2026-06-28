import type { PandaDocHttp } from "../http"
import { pathPart } from "../http"
import { listAllPages } from "../pagination"
import type {
  PandaDocResultsResponse,
  PandaDocTemplateCreateOptions,
  PandaDocTemplateDetails,
  PandaDocTemplateEditingSessionInput,
  PandaDocTemplateInput,
  PandaDocTemplateListOptions,
  PandaDocTemplateSettings,
  PandaDocTemplateSummary,
  QueryParams,
} from "../types"

export interface TemplatesResource {
  /** `GET /public/v1/templates` */
  list(
    options?: PandaDocTemplateListOptions
  ): Promise<PandaDocResultsResponse<PandaDocTemplateSummary>>
  listAll(options?: PandaDocTemplateListOptions): AsyncIterable<PandaDocTemplateSummary>
  /** `POST /public/v1/templates` */
  create(
    input: PandaDocTemplateInput,
    options?: PandaDocTemplateCreateOptions
  ): Promise<PandaDocTemplateSummary>
  /** `POST /public/v1/templates?upload` */
  createFromUpload(
    body: BodyInit,
    options?: PandaDocTemplateCreateOptions
  ): Promise<PandaDocTemplateSummary>
  /** `GET /public/v1/templates/{id}` */
  status(id: string): Promise<PandaDocTemplateSummary>
  /** `GET /public/v1/templates/{id}/details` */
  details(id: string): Promise<PandaDocTemplateDetails>
  /** `PATCH /public/v1/templates/{id}` */
  update(id: string, input: Partial<PandaDocTemplateInput>): Promise<PandaDocTemplateSummary>
  /** `DELETE /public/v1/templates/{id}` */
  delete(id: string): Promise<void>
  /** `POST /public/v1/templates/{id}/editing-sessions` */
  createEditingSession(
    id: string,
    input: PandaDocTemplateEditingSessionInput
  ): Promise<PandaDocTemplateSummary>
  /** `GET /public/v2/templates/{template_id}/settings` */
  settings(id: string): Promise<PandaDocTemplateSettings>
  /** `PATCH /public/v2/templates/{template_id}/settings` */
  updateSettings(id: string, input: PandaDocTemplateSettings): Promise<PandaDocTemplateSettings>
}

export function templatesResource(http: PandaDocHttp): TemplatesResource {
  const resource: TemplatesResource = {
    list(options) {
      return http.get("public/v1/templates", options)
    },
    listAll(options) {
      return listAllPages(resource.list, (page) => page.results, options)
    },
    create(input, options) {
      return http.post("public/v1/templates", input, templateOptionsQuery(options))
    },
    createFromUpload(body, options) {
      return http.post("public/v1/templates?upload", body, templateOptionsQuery(options))
    },
    status(id) {
      return http.get(`public/v1/templates/${pathPart(id, "template id")}`)
    },
    details(id) {
      return http.get(`public/v1/templates/${pathPart(id, "template id")}/details`)
    },
    update(id, input) {
      return http.patch(`public/v1/templates/${pathPart(id, "template id")}`, input)
    },
    delete(id) {
      return http.delete(`public/v1/templates/${pathPart(id, "template id")}`)
    },
    createEditingSession(id, input) {
      return http.post(`public/v1/templates/${pathPart(id, "template id")}/editing-sessions`, input)
    },
    settings(id) {
      return http.get(`public/v2/templates/${pathPart(id, "template id")}/settings`)
    },
    updateSettings(id, input) {
      return http.patch(`public/v2/templates/${pathPart(id, "template id")}/settings`, input)
    },
  }

  return resource
}

function templateOptionsQuery(
  options: PandaDocTemplateCreateOptions | undefined
): QueryParams | undefined {
  if (!options) {
    return undefined
  }

  return {
    editor_ver: options.editor_ver,
  }
}
