# @sixb/logger-pino

Pino output provider for Sixb handler logs.

```ts
import { createSixb } from "@sixb/core"
import { PinoLogger } from "@sixb/logger-pino"

const sixb = await createSixb({
  logger: new PinoLogger({ level: "info" }),
  observability: {
    logs: {
      enabled: true,
      level: "info",
    },
  },
})
```

`logger` controls process output. `observability.logs` independently controls
the temporary broker copy consumed by Atlas, including its capture level and
retention limits.

- `new PinoLogger()` writes structured JSON to stdout at `info`.
- `new PinoLogger({ instance })` reuses a configured Pino instance, including
  transports, redaction, and destinations.
- `flush()` and `close()` drain Pino and propagate failures. Injected
  destinations remain owned by their caller.

Every entry includes immutable framework metadata under `sixb`, for example:

```json
{"msg":"started","orderId":"o_1","sixb":{"run":{"kind":"sync","id":"run_1"}}}
```
