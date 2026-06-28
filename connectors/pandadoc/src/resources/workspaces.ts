import type { PandaDocHttp } from "../http"
import { pathPart } from "../http"
import type {
  PandaDocApiKeyInput,
  PandaDocJsonObject,
  PandaDocResultsResponse,
  PandaDocWorkspace,
  PandaDocWorkspaceInput,
  PandaDocWorkspaceListOptions,
  PandaDocWorkspaceMemberInput,
  PandaDocWorkspaceMemberNotifyOptions,
  PandaDocWorkspaceMemberRoleInput,
} from "../types"

export interface WorkspacesResource {
  /** `GET /public/v1/workspaces` */
  list(options?: PandaDocWorkspaceListOptions): Promise<PandaDocResultsResponse<PandaDocWorkspace>>
  /** `POST /public/v1/workspaces` */
  create(input: PandaDocWorkspaceInput): Promise<PandaDocWorkspace>
  /** `POST /public/v1/workspaces/{workspace_id}/deactivate` */
  deactivate(workspaceId: string, input?: PandaDocJsonObject): Promise<PandaDocJsonObject>
  /** `POST /public/v1/workspaces/{workspace_id}/members` */
  addMember(
    workspaceId: string,
    input: PandaDocWorkspaceMemberInput,
    options?: PandaDocWorkspaceMemberNotifyOptions
  ): Promise<PandaDocJsonObject>
  /** `DELETE /public/v1/workspaces/{workspace_id}/members/{member_id}` */
  removeMember(workspaceId: string, memberId: string): Promise<void>
  /** `PATCH /public/v1/workspaces/{workspace_id}/members/{member_id}/role` */
  changeMemberRole(
    workspaceId: string,
    memberId: string,
    input: PandaDocWorkspaceMemberRoleInput
  ): Promise<PandaDocJsonObject>
  /** `POST /public/v1/workspaces/{workspace_id}/api-keys` */
  createApiKey(workspaceId: string, input: PandaDocApiKeyInput): Promise<PandaDocJsonObject>
}

export function workspacesResource(http: PandaDocHttp): WorkspacesResource {
  return {
    list(options) {
      return http.get("public/v1/workspaces", options)
    },
    create(input) {
      return http.post("public/v1/workspaces", input)
    },
    deactivate(workspaceId, input = {}) {
      return http.post(
        `public/v1/workspaces/${pathPart(workspaceId, "workspace id")}/deactivate`,
        input
      )
    },
    addMember(workspaceId, input, options) {
      return http.post(
        `public/v1/workspaces/${pathPart(workspaceId, "workspace id")}/members`,
        input,
        options
      )
    },
    removeMember(workspaceId, memberId) {
      return http.delete(
        `public/v1/workspaces/${pathPart(workspaceId, "workspace id")}/members/${pathPart(
          memberId,
          "member id"
        )}`
      )
    },
    changeMemberRole(workspaceId, memberId, input) {
      return http.patch(
        `public/v1/workspaces/${pathPart(workspaceId, "workspace id")}/members/${pathPart(
          memberId,
          "member id"
        )}/role`,
        input
      )
    },
    createApiKey(workspaceId, input) {
      return http.post(
        `public/v1/workspaces/${pathPart(workspaceId, "workspace id")}/api-keys`,
        input
      )
    },
  }
}
