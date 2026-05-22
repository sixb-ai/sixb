export abstract class Worker {
  private controller: AbortController | null = null
  private running: Promise<void> | null = null

  async start(): Promise<void> {
    if (this.controller) return
    this.controller = new AbortController()
    this.running = this.run(this.controller.signal)
    this.running.catch(() => {})
  }

  async stop(): Promise<void> {
    if (!this.controller) return
    this.controller.abort()
    await this.running?.catch(() => {})
    this.controller = null
    this.running = null
  }

  protected abstract run(signal: AbortSignal): Promise<void>
}
