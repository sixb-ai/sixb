// The server resolves each request's client address once, at the socket, from the peer address
// and the forwarding headers its trusted proxies wrote. Everything else reads it from here and
// never parses forwarding headers itself: a client can write any value into them.
const clientAddresses = new WeakMap<Request, string>()

export function setRequestClientAddress(request: Request, address: string): void {
  clientAddresses.set(request, address)
}

export function getRequestClientAddress(request: Request): string | undefined {
  return clientAddresses.get(request)
}
