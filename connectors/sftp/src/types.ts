import type { ConnectorAdapter } from "@sixb/core"
import type { ConnectConfig, FileEntryWithStats, Stats } from "ssh2"

export type SftpConnection = ConnectConfig
export type SftpListEntry = FileEntryWithStats
export type SftpStats = Stats

export type SftpWriteData = string | Buffer | ArrayBuffer | ArrayBufferView

export interface SftpClient {
  list(path: string): Promise<readonly SftpListEntry[]>
  stat(path: string): Promise<SftpStats>
  exists(path: string): Promise<boolean>
  ensureDir(path: string): Promise<void>
  read(path: string): Promise<Buffer>
  write(path: string, data: SftpWriteData): Promise<void>
  rename(sourcePath: string, destinationPath: string): Promise<void>
  delete(path: string): Promise<void>
  mkdir(path: string): Promise<void>
  rmdir(path: string): Promise<void>
}

export type SftpConnector = ConnectorAdapter<"sftp", SftpClient>
