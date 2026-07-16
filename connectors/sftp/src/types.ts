import type { ConnectorAdapter } from "@sixb/core"
import type { ConnectConfig, FileEntryWithStats, Stats } from "ssh2"

export type SftpConnection = ConnectConfig
export type SftpListEntry = FileEntryWithStats
export type SftpStats = Stats

export type SftpWriteData = string | Buffer | ArrayBuffer | ArrayBufferView

export interface SftpOptions {
  /**
   * Maximum number of read requests kept in flight for each streamed file.
   *
   * `1` preserves sequential reads. Values from `2` to `64` enable bounded
   * read-ahead while preserving stream order and backpressure. Defaults to `1`.
   */
  readonly readAheadRequests?: number
}

export interface SftpOpenOptions {
  readonly signal?: AbortSignal
}

export interface SftpClient {
  list(path: string): Promise<readonly SftpListEntry[]>
  stat(path: string): Promise<SftpStats>
  exists(path: string): Promise<boolean>
  ensureDir(path: string): Promise<void>
  open(path: string, options?: SftpOpenOptions): Promise<ReadableStream<Uint8Array>>
  read(path: string): Promise<Buffer>
  write(path: string, data: SftpWriteData): Promise<void>
  rename(sourcePath: string, destinationPath: string): Promise<void>
  delete(path: string): Promise<void>
  mkdir(path: string): Promise<void>
  rmdir(path: string): Promise<void>
}

export type SftpConnector = ConnectorAdapter<"sftp", SftpClient>
