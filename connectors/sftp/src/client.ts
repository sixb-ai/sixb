import { posix } from "node:path"
import type { Callback, SFTPWrapper } from "ssh2"
import type { SftpClient, SftpStats, SftpWriteData } from "./types"

export function createSftpClient(sftpClient: SFTPWrapper): SftpClient {
  return {
    list(path) {
      return callResult((callback) => sftpClient.readdir(path, callback))
    },
    stat(path) {
      return callResult((callback) => sftpClient.stat(path, callback))
    },
    exists(path) {
      return new Promise((resolve) => {
        sftpClient.exists(path, (exists) => resolve(exists))
      })
    },
    ensureDir(path) {
      return ensureSftpDirectory(sftpClient, path)
    },
    read(path) {
      return callResult((callback) => sftpClient.readFile(path, callback))
    },
    write(path, data) {
      return callVoid((callback) => sftpClient.writeFile(path, toBuffer(data), callback))
    },
    rename(sourcePath, destinationPath) {
      return callVoid((callback) => sftpClient.rename(sourcePath, destinationPath, callback))
    },
    delete(path) {
      return callVoid((callback) => sftpClient.unlink(path, callback))
    },
    mkdir(path) {
      return callVoid((callback) => sftpClient.mkdir(path, callback))
    },
    rmdir(path) {
      return callVoid((callback) => sftpClient.rmdir(path, callback))
    },
  }
}

async function ensureSftpDirectory(sftpClient: SFTPWrapper, path: string): Promise<void> {
  for (const directoryPath of directoryHierarchy(path)) {
    const exists = await new Promise<boolean>((resolve) => {
      sftpClient.exists(directoryPath, (value) => resolve(value))
    })

    if (exists) {
      await assertRemoteDirectory(sftpClient, directoryPath)
      continue
    }

    try {
      await callVoid((callback) => sftpClient.mkdir(directoryPath, callback))
    } catch (error) {
      const stats = await statIfExists(sftpClient, directoryPath)

      if (stats?.isDirectory()) {
        continue
      }

      if (stats) {
        throw new Error(
          `[SixbSftp] Cannot ensure directory ${directoryPath} because it exists and is not a directory.`
        )
      }

      throw error
    }
  }
}

function directoryHierarchy(path: string): string[] {
  if (!path) {
    throw new Error("[SixbSftp] directory path must not be empty.")
  }

  const normalizedPath = posix.normalize(path)

  if (normalizedPath === "." || normalizedPath === "/") {
    return []
  }

  const isAbsolute = normalizedPath.startsWith("/")
  const parts = normalizedPath.split("/").filter(Boolean)
  const hierarchy: string[] = []
  let currentPath = isAbsolute ? "/" : ""

  for (const part of parts) {
    currentPath = currentPath === "/" ? `/${part}` : currentPath ? `${currentPath}/${part}` : part
    hierarchy.push(currentPath)
  }

  return hierarchy
}

async function assertRemoteDirectory(sftpClient: SFTPWrapper, path: string): Promise<void> {
  const stats = await statRemotePath(sftpClient, path)

  if (!stats.isDirectory()) {
    throw new Error(
      `[SixbSftp] Cannot ensure directory ${path} because it exists and is not a directory.`
    )
  }
}

async function statIfExists(sftpClient: SFTPWrapper, path: string): Promise<SftpStats | null> {
  const exists = await new Promise<boolean>((resolve) => {
    sftpClient.exists(path, (value) => resolve(value))
  })

  if (!exists) {
    return null
  }

  return statRemotePath(sftpClient, path)
}

function statRemotePath(sftpClient: SFTPWrapper, path: string): Promise<SftpStats> {
  return callResult<SftpStats>((callback) => sftpClient.stat(path, callback))
}

function callVoid(method: (callback: Callback) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    method((error) => {
      if (error) {
        reject(error)
        return
      }

      resolve()
    })
  })
}

function callResult<T>(
  method: (callback: (error: Error | undefined, result: T) => void) => void
): Promise<T> {
  return new Promise((resolve, reject) => {
    method((error, result) => {
      if (error) {
        reject(error)
        return
      }

      resolve(result)
    })
  })
}

function toBuffer(data: SftpWriteData): string | Buffer {
  if (typeof data === "string" || Buffer.isBuffer(data)) {
    return data
  }

  if (data instanceof ArrayBuffer) {
    return Buffer.from(data)
  }

  return Buffer.from(data.buffer, data.byteOffset, data.byteLength)
}
