/**
 * Build the multipart body ACE's two upload routes expect. Both read the upload from a `file` form
 * field. A `Blob` carries no name, so fall back to the `File` name when there is one and let
 * `FormData` supply its default otherwise.
 */
export function fileUpload(file: Blob | File, filename?: string): FormData {
  const form = new FormData()
  const name = filename ?? ("name" in file && typeof file.name === "string" ? file.name : undefined)

  if (name) {
    form.append("file", file, name)
  } else {
    form.append("file", file)
  }

  return form
}
