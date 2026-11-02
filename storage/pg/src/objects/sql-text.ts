export function identifier(value: string): string {
  return `"${value.replace(/"/g, '""')}"`
}

export function literal(value: string): string {
  if (value.includes("\0")) throw new Error("[SixbPg] SQL literals cannot contain NUL")
  return `E'${value.replace(/\\/g, "\\\\").replace(/'/g, "''")}'`
}
