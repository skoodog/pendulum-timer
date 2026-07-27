// STUB — replaced by the scoring agent.
export function createScoring(ctx) {
  return { score: 0, multiplier: 1, comboScore: 0, special: 0, timeLeft: 120, goals: [], fixedUpdate(fdt) { this.timeLeft = Math.max(0, this.timeLeft - fdt); }, dispose() {} };
}
