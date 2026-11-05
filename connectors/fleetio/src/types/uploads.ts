export interface FleetioUploadOptions {
  /** The name to store the file under. Defaults to the name on a `File`. */
  readonly filename?: string
  /** Defaults to the type on the `Blob` or `File`. */
  readonly contentType?: string
}

/** An uploaded file. Pass `url` as `file_url` in `images_attributes` or `documents_attributes`. */
export interface FleetioUploadedFile {
  readonly url: string
  readonly filename: string
  readonly type: string
  readonly size: number
  readonly key?: string
  readonly container?: string
}
