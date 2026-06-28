import type { PandaDocHttp } from "../http"
import { pathPart } from "../http"
import type { PandaDocFolder, PandaDocFolderInput, PandaDocResultsResponse } from "../types"

export interface FolderTreeResource {
  list(): Promise<PandaDocResultsResponse<PandaDocFolder>>
  create(input: PandaDocFolderInput): Promise<PandaDocFolder>
  rename(id: string, input: Pick<PandaDocFolderInput, "name">): Promise<PandaDocFolder>
}

export interface FoldersResource {
  readonly documents: FolderTreeResource
  readonly templates: FolderTreeResource
}

export function foldersResource(http: PandaDocHttp): FoldersResource {
  return {
    documents: folderTreeResource(http, "documents"),
    templates: folderTreeResource(http, "templates"),
  }
}

function folderTreeResource(
  http: PandaDocHttp,
  type: "documents" | "templates"
): FolderTreeResource {
  const basePath = `public/v1/${type}/folders`

  return {
    list() {
      return http.get(basePath)
    },
    create(input) {
      return http.post(basePath, input)
    },
    rename(id, input) {
      return http.put(`${basePath}/${pathPart(id, "folder id")}`, input)
    },
  }
}
