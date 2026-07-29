export function serviceCaseIdentity(alarmId: string): { id: string; number: string } {
  const known: Record<string, string> = {
    "alarm-delaware-controller-offline": "1035",
    "alarm-keystone-boiler-lockout": "1038",
    "alarm-broad-ahu-damper": "1040",
    "alarm-camden-condenser-fan": "1041",
    "alarm-harbor-rtu-7-vfd": "1042",
  }
  const number = known[alarmId] ?? String(1100 + (stableNumber(alarmId) % 800))
  return { id: `case-sc-${number}`, number: `SC-${number}` }
}

function stableNumber(value: string): number {
  return [...value].reduce((result, character, index) => {
    return result + character.charCodeAt(0) * (index + 1)
  }, 0)
}
