import type { MicrosoftHttp } from "../../http"
import type { SelectOptions } from "../../types/common"
import type { Drive } from "../../types/files"
import { query, resource } from "../../validation"
import { type DriveDeltaResource, deltaResource } from "./delta"
import { type DriveItemsResource, itemsResource } from "./items"
import { drivePath } from "./paths"
import { type DriveUploadsResource, uploadsResource } from "./uploads"

export interface DrivesSurface {
  get(driveId: string, options?: SelectOptions): Promise<Drive>
  readonly items: DriveItemsResource
  readonly delta: DriveDeltaResource
  readonly uploads: DriveUploadsResource
}

export function drivesSurface(http: MicrosoftHttp): DrivesSurface {
  return {
    async get(driveId, options) {
      return resource(
        await http.json(`${drivePath(driveId)}${query(options)}`, { signal: options?.signal })
      )
    },
    items: itemsResource(http),
    delta: deltaResource(http),
    uploads: uploadsResource(http),
  }
}
