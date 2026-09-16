/** Shared little-endian float32 encoding for stored vectors and sqlite-vec query bindings. */
export function encodeSqliteVector(values: readonly number[]): Uint8Array {
  const bytes = new Uint8Array(values.length * 4)
  const view = new DataView(bytes.buffer)
  for (let index = 0; index < values.length; index++) {
    view.setFloat32(index * 4, values[index]!, true)
  }
  return bytes
}
