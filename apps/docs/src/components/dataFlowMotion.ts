const holdMs = 1800
const travelMs = 1200
export const flowStepMs = holdMs + travelMs
const stageCount = 6
const splitMs = 1200
const endHoldMs = 600
const splitStart = flowStepMs * stageCount

/** One clock drives the line, ontology, and the three final branches. */
export function dataFlowFrame(elapsed: number) {
  const cycle = elapsed % (splitStart + splitMs + endHoldMs)
  const stage = Math.min(stageCount - 1, Math.floor(cycle / flowStepMs))
  const travel = Math.min(1, Math.max(0, (cycle - stage * flowStepMs - holdMs) / travelMs))
  return {
    stage,
    ontologyActive: stage === 4 || (stage === 3 && travel >= 0.5),
    // The last leg ends at the junction, half a row below the last node.
    position: ((0.5 + stage + travel * (stage === 5 ? 0.5 : 1)) / stageCount) * 100,
    travelling: travel > 0 && cycle < splitStart,
    branchProgress: Math.min(1, Math.max(0, (cycle - splitStart) / splitMs)),
    branching: cycle >= splitStart && cycle < splitStart + splitMs,
    branchesArrived: cycle >= splitStart + splitMs,
  }
}
