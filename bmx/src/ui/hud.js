// STUB — replaced by the HUD agent.
export function createHUD(ctx) {
  const root = document.getElementById('ui-root');
  const el = document.createElement('div');
  el.className = 'hud';
  el.innerHTML = '<div class=\'hud-score\'>0</div>';
  root.appendChild(el);
  const scoreEl = el.querySelector('.hud-score');
  return { root: el, update(dt, ctx) { scoreEl.textContent = Math.floor(ctx.player.scoring.score).toLocaleString(); }, dispose() { el.remove(); } };
}
