import type { GoogleHttp } from "./http"
import { type DriveChangesResource, driveChangesResource } from "./surfaces/drive/changes"
import { type DriveFilesResource, driveFilesResource } from "./surfaces/drive/files"

export interface DriveSurface {
  readonly files: DriveFilesResource
  readonly changes: DriveChangesResource
}

export interface GoogleClient {
  readonly drive: DriveSurface
}

export function createGoogleClient(http: GoogleHttp): GoogleClient {
  return {
    drive: {
      files: driveFilesResource(http),
      changes: driveChangesResource(http),
    },
  }
}
