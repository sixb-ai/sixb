export class FileUploadSessionError extends Error {
  readonly name = "FileUploadSessionError"

  constructor(
    message: string,
    readonly status: number
  ) {
    super(message)
  }
}
