export class EditBatchError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "EditBatchError"
  }
}
