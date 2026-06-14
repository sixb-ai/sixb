export class EditStorageError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "EditStorageError"
  }
}
