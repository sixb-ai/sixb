export function formatMoney(money: { currency: string; amountNanos: string }): string {
  const nanos = BigInt(money.amountNanos)
  const whole = nanos / 1_000_000_000n
  const fraction = (nanos % 1_000_000_000n).toString().padStart(9, "0").replace(/0+$/, "")
  return `${money.currency} ${whole.toLocaleString("en-US")}${fraction ? `.${fraction.padEnd(2, "0")}` : ".00"}`
}
