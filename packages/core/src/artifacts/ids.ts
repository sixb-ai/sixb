// Lowercase base32 without the letters easiest to misread. Ten characters is 50 bits: short enough
// for the Agent to write in an address, and the store refuses the rare collision.
const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz"

/** A new artifact id, such as `art_k3m9q2x7tp`. */
export function createArtifactId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(10))
  let id = "art_"
  for (const byte of bytes) id += ALPHABET[byte % ALPHABET.length]
  return id
}

const ARTIFACT_ID = new RegExp(`^art_[${ALPHABET}]{10}$`)

/** Whether `value` has the shape of an artifact id; whether that artifact exists is another matter. */
export function isArtifactId(value: string): boolean {
  return ARTIFACT_ID.test(value)
}
