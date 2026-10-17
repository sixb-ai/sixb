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
