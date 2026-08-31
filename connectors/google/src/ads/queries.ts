import type { GoogleAdsCustomerDailyPerformanceOptions } from "./types"
import { assertIsoDateRange } from "./validation"

/** Enabled leaf advertisers below the configured manager; the manager itself is excluded. */
export const MANAGED_CUSTOMERS_QUERY = `SELECT
  customer_client.client_customer,
  customer_client.id,
  customer_client.level,
  customer_client.manager,
  customer_client.descriptive_name,
  customer_client.currency_code,
  customer_client.time_zone,
  customer_client.status,
  customer_client.test_account,
  customer_client.hidden
FROM customer_client
WHERE customer_client.level > 0
  AND customer_client.manager = FALSE
  AND customer_client.status = ENABLED
ORDER BY customer_client.id`

export function customerDailyPerformanceQuery(
  options: GoogleAdsCustomerDailyPerformanceOptions
): string {
  assertIsoDateRange(options.startDate, options.endDate)
  return `SELECT
  customer.id,
  customer.descriptive_name,
  customer.currency_code,
  customer.time_zone,
  segments.date,
  metrics.impressions,
  metrics.clicks,
  metrics.interactions,
  metrics.cost_micros,
  metrics.conversions,
  metrics.conversions_value,
  metrics.all_conversions,
  metrics.all_conversions_value,
  metrics.view_through_conversions
FROM customer
WHERE segments.date BETWEEN '${options.startDate}' AND '${options.endDate}'
ORDER BY segments.date`
}
