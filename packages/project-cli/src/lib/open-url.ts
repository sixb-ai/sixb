/** Opens a URL in the default browser. A failure is quiet: the URL is already on screen. */
export async function openUrl(url: string): Promise<void> {
  const command =
    process.platform === "darwin"
      ? ["open", url]
      : process.platform === "win32"
        ? ["cmd.exe", "/c", "start", "", url]
        : ["xdg-open", url]
  try {
    const opened = Bun.spawn({ cmd: command, stdout: "ignore", stderr: "ignore" })
    await opened.exited
  } catch {
    // Nothing to open it with; the URL was printed.
  }
}
