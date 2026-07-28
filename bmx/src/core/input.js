// Keyboard + gamepad input with edge detection and an input buffer for tricks.

const DEFAULT_BINDS = {
  forward: ['KeyW', 'ArrowUp'],
  back: ['KeyS', 'ArrowDown'],
  left: ['KeyA', 'ArrowLeft'],
  right: ['KeyD', 'ArrowRight'],
  pedal: ['ShiftLeft', 'ShiftRight'],
  brake: ['KeyS'],
  hop: ['Space'],
  spinLeft: ['KeyQ'],
  spinRight: ['KeyE'],
  trickA: ['KeyJ'],   // air trick set A / grind modifier
  trickB: ['KeyK'],   // air trick set B
  trickC: ['KeyL'],   // air trick set C (flips)
  grind: ['KeyU'],
  manual: ['KeyI'],
  special: ['KeyO'],
  reset: ['KeyR'],
  pause: ['Escape'],
  camera: ['KeyC'],
  debug: ['Backquote'],
};

const PAD_MAP = {
  hop: 0, trickA: 2, trickB: 3, trickC: 1, grind: 5, manual: 4,
  special: 9, pause: 9, reset: 8, camera: 10,
};

export function createInput(domElement = window) {
  const binds = structuredClone(DEFAULT_BINDS);
  const down = new Set();
  const prev = new Set();
  const lastPressAt = new Map();
  let padIndex = null;
  let pad = null;
  let now = 0;

  const state = {
    steer: 0,        // -1 .. 1
    throttle: 0,     // 0 .. 1 pedalling
    brake: 0,        // 0 .. 1
    lean: 0,         // -1 .. 1 (pitch: manual / nose manual)
    look: { x: 0, y: 0 },
    anyGamepad: false,
  };

  const keyToActions = new Map();
  function rebuild() {
    keyToActions.clear();
    for (const [action, keys] of Object.entries(binds)) {
      for (const k of keys) {
        if (!keyToActions.has(k)) keyToActions.set(k, []);
        keyToActions.get(k).push(action);
      }
    }
  }
  rebuild();

  const onKeyDown = (e) => {
    if (e.repeat) return;
    const actions = keyToActions.get(e.code);
    if (!actions) return;
    e.preventDefault();
    for (const a of actions) { down.add(a); lastPressAt.set(a, now); }
  };
  const onKeyUp = (e) => {
    const actions = keyToActions.get(e.code);
    if (!actions) return;
    e.preventDefault();
    for (const a of actions) down.delete(a);
  };
  const onBlur = () => down.clear();

  window.addEventListener('keydown', onKeyDown, { passive: false });
  window.addEventListener('keyup', onKeyUp, { passive: false });
  window.addEventListener('blur', onBlur);
  window.addEventListener('gamepadconnected', (e) => { padIndex = e.gamepad.index; });
  window.addEventListener('gamepaddisconnected', () => { padIndex = null; pad = null; });

  const dz = (v, d = 0.18) => (Math.abs(v) < d ? 0 : (v - Math.sign(v) * d) / (1 - d));

  const api = {
    state,
    binds,
    setBind(action, keys) { binds[action] = keys; rebuild(); },

    poll(elapsedMs) {
      now = elapsedMs;
      prev.clear();
      for (const a of down) prev.add(a);

      // gamepad merge
      pad = null;
      if (typeof navigator !== 'undefined' && navigator.getGamepads) {
        const pads = navigator.getGamepads();
        pad = (padIndex != null ? pads[padIndex] : null) || pads[0] || null;
      }
      state.anyGamepad = !!pad;

      let steer = (api.held('right') ? 1 : 0) - (api.held('left') ? 1 : 0);
      let lean = (api.held('back') ? 1 : 0) - (api.held('forward') ? 1 : 0);
      let throttle = api.held('pedal') ? 1 : (api.held('forward') ? 0.55 : 0);
      let brake = api.held('brake') && !api.held('pedal') ? 1 : 0;

      if (pad) {
        const ax = dz(pad.axes[0] || 0), ay = dz(pad.axes[1] || 0);
        if (ax) steer = ax;
        if (ay) lean = ay;
        const rt = pad.buttons[7]?.value || 0;
        const lt = pad.buttons[6]?.value || 0;
        if (rt > 0.05) throttle = rt;
        if (lt > 0.05) brake = lt;
        state.look.x = dz(pad.axes[2] || 0);
        state.look.y = dz(pad.axes[3] || 0);
        for (const [action, btn] of Object.entries(PAD_MAP)) {
          const pressed = pad.buttons[btn]?.pressed;
          if (pressed && !down.has(action)) { down.add(action); lastPressAt.set(action, now); }
          else if (!pressed && down.has(action) && !api._keyHeld(action)) down.delete(action);
        }
      }

      state.steer = steer;
      state.lean = lean;
      state.throttle = throttle;
      state.brake = brake;

      // Scripted-input hook used by the screenshot harness / demo autopilot.
      if (api.harness) {
        const h = api.harness(now, api);
        if (h) {
          if (h.steer != null) state.steer = h.steer;
          if (h.lean != null) state.lean = h.lean;
          if (h.throttle != null) state.throttle = h.throttle;
          if (h.brake != null) state.brake = h.brake;
          if (h.press) for (const a of h.press) { down.add(a); lastPressAt.set(a, now); }
          if (h.release) for (const a of h.release) down.delete(a);
        }
      }
    },

    /** fn(nowMs, input) -> { steer, lean, throttle, brake, press:[], release:[] } | null */
    harness: null,

    _keyHeld(action) {
      // whether a physical key (not pad) currently holds this action — approximation
      return false;
    },
    held: (a) => down.has(a),
    pressed: (a) => down.has(a) && !prev.has(a),
    released: (a) => !down.has(a) && prev.has(a),
    /** Was `a` pressed within the last `ms` milliseconds? Used for trick buffering. */
    bufferedIn(a, ms = 220) {
      const t = lastPressAt.get(a);
      return t != null && now - t <= ms;
    },
    consumeBuffer(a) { lastPressAt.delete(a); },
    dispose() {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
    },
  };

  return api;
}
