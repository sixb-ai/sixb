# Telemetry API

All requests go through `$SIXB_API_BASE_URL`. Do not add Authorization or Cookie headers.

## Latest Point

```bash
curl -sS "$SIXB_API_BASE_URL/api/objects/device/fan-1/telemetry/rpm/latest"
```

## Single-Series History

```bash
curl -sS "$SIXB_API_BASE_URL/api/objects/device/fan-1/telemetry/rpm/history?limit=100&order=desc"
```

Useful query params include `from`, `to`, `limit`, and `order`.

## Bulk History

```bash
curl -sS \
  -H "Content-Type: application/json" \
  -X POST "$SIXB_API_BASE_URL/api/telemetry/history" \
  --data '{
    "series": [
      { "objectTypeId": "device", "objectId": "fan-1", "propertyId": "rpm" },
      { "objectTypeId": "device", "objectId": "fan-2", "propertyId": "rpm" }
    ],
    "limitPerSeries": 100,
    "order": "desc"
  }'
```
