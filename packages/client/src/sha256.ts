/**
 * Zero-dependency streaming SHA-256 (FIPS 180-4).
 *
 * `SubtleCrypto.digest` has no incremental API, so hashing a file through it
 * means buffering the whole file in memory before hashing. This implementation
 * absorbs data one chunk at a time, keeping peak memory bounded to a single
 * slice — letting the client hash multi-gigabyte uploads without OOM. Output is
 * byte-identical to `crypto.subtle.digest("SHA-256", ...)`.
 */

// FIPS 180-4 §4.2.2 round constants (first 32 bits of the fractional parts of
// the cube roots of the first 64 primes).
const ROUND_CONSTANTS = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
])

function rotr(value: number, bits: number): number {
  return (value >>> bits) | (value << (32 - bits))
}

class Sha256 {
  private readonly state = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ])
  private readonly pending = new Uint8Array(64)
  private pendingLength = 0
  private totalBytes = 0
  private readonly schedule = new Uint32Array(64)

  update(data: Uint8Array): void {
    this.totalBytes += data.byteLength
    let offset = 0

    if (this.pendingLength > 0) {
      const take = Math.min(64 - this.pendingLength, data.byteLength)
      this.pending.set(data.subarray(0, take), this.pendingLength)
      this.pendingLength += take
      offset = take
      if (this.pendingLength === 64) {
        this.compress(this.pending, 0)
        this.pendingLength = 0
      }
    }

    while (offset + 64 <= data.byteLength) {
      this.compress(data, offset)
      offset += 64
    }

    if (offset < data.byteLength) {
      const rest = data.subarray(offset)
      this.pending.set(rest, 0)
      this.pendingLength = rest.byteLength
    }
  }

  digest(): Uint8Array {
    // Message length in bits as a 64-bit big-endian value. `totalBytes` is exact
    // in a double well past any real upload size (2^53 bits ≈ 1 PB).
    const bitsHigh = Math.floor(this.totalBytes / 0x20000000) >>> 0
    const bitsLow = (this.totalBytes * 8) >>> 0

    const paddingLength =
      this.pendingLength < 56 ? 56 - this.pendingLength : 120 - this.pendingLength
    const tail = new Uint8Array(paddingLength + 8)
    tail[0] = 0x80
    const tailView = new DataView(tail.buffer)
    tailView.setUint32(tail.byteLength - 8, bitsHigh)
    tailView.setUint32(tail.byteLength - 4, bitsLow)
    this.update(tail)

    const digest = new Uint8Array(32)
    const digestView = new DataView(digest.buffer)
    for (let i = 0; i < 8; i++) {
      digestView.setUint32(i * 4, this.state[i])
    }
    return digest
  }

  private compress(block: Uint8Array, offset: number): void {
    const w = this.schedule
    for (let i = 0; i < 16; i++) {
      const j = offset + i * 4
      w[i] = (block[j] << 24) | (block[j + 1] << 16) | (block[j + 2] << 8) | block[j + 3]
    }
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3)
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10)
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0
    }

    let a = this.state[0]
    let b = this.state[1]
    let c = this.state[2]
    let d = this.state[3]
    let e = this.state[4]
    let f = this.state[5]
    let g = this.state[6]
    let h = this.state[7]

    for (let i = 0; i < 64; i++) {
      const bigSigma1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)
      const ch = (e & f) ^ (~e & g)
      const temp1 = (h + bigSigma1 + ch + ROUND_CONSTANTS[i] + w[i]) >>> 0
      const bigSigma0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)
      const maj = (a & b) ^ (a & c) ^ (b & c)
      const temp2 = (bigSigma0 + maj) >>> 0

      h = g
      g = f
      f = e
      e = (d + temp1) >>> 0
      d = c
      c = b
      b = a
      a = (temp1 + temp2) >>> 0
    }

    this.state[0] = (this.state[0] + a) >>> 0
    this.state[1] = (this.state[1] + b) >>> 0
    this.state[2] = (this.state[2] + c) >>> 0
    this.state[3] = (this.state[3] + d) >>> 0
    this.state[4] = (this.state[4] + e) >>> 0
    this.state[5] = (this.state[5] + f) >>> 0
    this.state[6] = (this.state[6] + g) >>> 0
    this.state[7] = (this.state[7] + h) >>> 0
  }
}

function toHex(bytes: Uint8Array): string {
  let hex = ""
  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, "0")
  }
  return hex
}

/**
 * Streams `file` through SHA-256 in `chunkBytes`-sized slices and returns the
 * `sha256:<hex>` digest used for content-addressed blob identity.
 */
export async function computeStreamingBlobDigest(
  file: Blob,
  chunkBytes = 8 * 1024 * 1024
): Promise<`sha256:${string}`> {
  const hasher = new Sha256()
  for (let offset = 0; offset < file.size; offset += chunkBytes) {
    const slice = file.slice(offset, Math.min(file.size, offset + chunkBytes))
    hasher.update(new Uint8Array(await slice.arrayBuffer()))
  }
  return `sha256:${toHex(hasher.digest())}`
}
