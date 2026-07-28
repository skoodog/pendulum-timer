export const meta = {
  name: 'bmx-input-settings',
  description: 'Controller-first input, procedural button glyphs, full remapping and the settings screen',
  phases: [{ title: 'Input & Settings', detail: 'gamepad layer, glyph kit, settings screen' }],
}

const PRE = `You are working on a AAA-quality third-person BMX freestyle game in Three.js at
/home/user/pendulum-timer/bmx (cwd). Structure is Tony Hawk's Pro Skater; trick feel is Dave Mirra
Freestyle BMX 2. This is a single-map demo: full trick list, 2:00 runs, persistent high scores,
achievements, challenges, collectibles.

FIRST read ARCHITECTURE.md IN FULL - especially the sections "DEMO SCOPE", "ART DIRECTION TARGET",
"HUD LAYOUT", "SECOND REFERENCE", "CONTROLLER SUPPORT" and "SETTINGS SCREEN" at the end. Then read
reference/target-look.png with the Read tool (it renders as an image) - it is the visual and HUD
target. Then read the code you touch or depend on:
  src/core/input.js, src/main.js, src/core/engine.js
  src/ui/hud.js, src/ui/hud.css, src/ui/screens.js
  src/gameplay/tricks.js, src/gameplay/scoring.js, src/audio/audio.js

NON-NEGOTIABLE RULES
- You own ONLY the file(s) in YOUR TASK. Other agents edit siblings concurrently.
- ES modules, no external assets, no webfonts, no images - glyphs are drawn with CSS/SVG/canvas.
- Never break existing call sites: main.js, hud.js, tricks.js and grind.js already call input.
- Real, finished code. No TODOs.
- Verify: npx esbuild YOUR_FILE --bundle --external:three --outfile=/dev/null --format=esm
- All branding invented. No real trademarks.
`

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['file', 'summary', 'implemented', 'exports', 'notes'],
  properties: {
    file: { type: 'string' },
    summary: { type: 'string' },
    implemented: { type: 'array', items: { type: 'string' } },
    exports: { type: 'array', items: { type: 'string' } },
    notes: { type: 'string' },
  },
}

const TASKS = [
  {
    label: 'input-gamepad',
    prompt: `YOUR TASK: rewrite src/core/input.js as a controller-first input layer. You own this file only.

MUST NOT BREAK: the existing API surface other modules already use -
  input.state { steer, throttle, brake, lean, look:{x,y}, anyGamepad }
  input.held(a) / pressed(a) / released(a) / bufferedIn(a, ms) / consumeBuffer(a)
  input.binds, input.setBind(action, keys), input.poll(elapsedMs), input.harness, input.dispose()
Keep every one of those working exactly as now, then extend.

Add:
- A proper Gamepad API layer following the CONTROLLER SUPPORT section of ARCHITECTURE.md: standard
  mapping with left stick steer/lean, right stick camera look, A hop, X/Y/B trick modifiers, RB grind,
  LB trick list, RT pedal, LT brake, LS manual, Start pause, Back restart, d-pad as a digital
  alternative to the left stick. Handle triggers exposed as buttons OR axes, handle non-standard
  mappings by falling back to index mapping, and support hot plug/unplug of multiple pads.
- Per-device bind tables: binds.keyboard and binds.gamepad, each action mapping to an array of
  inputs, with setBind(action, device, inputs), conflict detection (returns the clashing action),
  resetDefaults(device), and serialisation to/from localStorage under a namespaced key.
- A rebinding capture mode: beginCapture(action, device) resolves with the next key or pad button
  pressed (with an escape/cancel path and a timeout), used by the settings screen.
- Analog handling: configurable radial deadzone per stick, response curve (linear/quadratic) with a
  sensitivity multiplier, invert-Y for the camera stick.
- activeDevice tracking ('gamepad' | 'keyboard') that flips the moment the player uses the other
  device, plus an onDeviceChange(fn) subscription so the UI can swap glyphs live.
- Vibration: rumble(strong, weak, ms) via gamepad.vibrationActuator with a graceful no-op when
  unsupported, a master enable flag and a strength multiplier, and a small queue so overlapping
  effects do not stomp each other.
- A glyphFor(action) helper returning { device, label, kind } that src/ui/glyphs.js can render.
- Keep poll() allocation-free.
Document the default bind table in a comment block at the top of the file.`,
  },
  {
    label: 'glyphs',
    prompt: `YOUR TASK: create src/ui/glyphs.js - procedurally drawn input glyphs. You own this file only.

Export a small library the HUD, screens and settings all use to render button prompts:
  createGlyphs() -> { el(actionOrInput, opts) -> HTMLElement, svg(name) -> string, css -> string }
Requirements:
- Xbox face buttons A/B/X/Y as circular glyphs with the correct colours (A green, B red, X blue,
  Y yellow) and a crisp letter, LB/RB as rounded shoulder chips, LT/RT as trigger chips, left/right
  stick glyphs (with a direction indicator variant), d-pad glyph, Start/Back (menu/view) glyphs.
- Keyboard key glyphs: rounded keycap with the key label, wide variants for Space/Shift/Enter, and
  arrow-key glyphs.
- Everything drawn as inline SVG or styled DOM - no images, no webfonts, no external requests.
  Must be crisp at any size, theme-able via CSS custom properties, and legible over both bright sky
  and dark concrete (built-in scrim/outline).
- A helper that takes an action name plus the current input device and returns the correct glyph,
  so every prompt in the game switches automatically when the player picks up the pad.
- An <style> injector guarded so it only runs once.
Also export a controller silhouette glyph (an Xbox-style pad outline) for the bottom-right HUD hint,
matching the reference frame - drawn as SVG paths, no image.`,
  },
  {
    label: 'settings',
    prompt: `YOUR TASK: create src/ui/settings.js - the settings screen. You own this file only.
Do NOT edit screens.js or hud.css; inject your own scoped <style> block. Read them for the visual
language and match it.

Implement createSettings(ctx) exporting { open(), close(), isOpen, update(dt, ctx), dispose } and
build the tabbed settings screen described in the SETTINGS SCREEN section of ARCHITECTURE.md:
Controls (device tabs, full action list with live glyphs from src/ui/glyphs.js, press-to-rebind with
a listening state and conflict warning, deadzone/sensitivity sliders, invert-Y, vibration toggle and
strength with a test-rumble button), Video (quality tier via ctx.engine.setQuality, resolution scale,
FOV, speed blur, bloom, grain, aberration, vignette, shadow quality, FPS counter toggle), Audio
(master/music/SFX/crowd sliders with live preview through ctx.audio), Gameplay (run length, HUD scale,
HUD element toggles, difficulty, camera distance/height, auto-restart on bail) and Data (reset high
scores / achievements / all progress, each behind a confirm step).
Requirements:
- Every control is operable by mouse, keyboard AND gamepad, with a clear focus ring, tab/shoulder
  navigation between sections, and A/Enter to activate, B/Escape to go back.
- Changes apply LIVE (no reload) and persist to localStorage under a namespaced key, with a safe
  load path if the stored shape is old or corrupt.
- Sliders show their numeric value; toggles animate; the whole panel has smooth open/close
  transitions and a blurred scrim over the game.
- Expose a settings object other modules can read, and emit a change event through ctx.emit so
  systems can react (e.g. hud scale, camera tuning).
- It must look like a shipped game's options menu: strong type hierarchy, consistent spacing,
  section headers, help text per row.`,
  },
]

phase('Input & Settings')
log('Building controller layer, glyph kit and settings screen')

const results = await parallel(TASKS.map((t) => () =>
  agent(PRE + '\n' + t.prompt, { label: t.label, phase: 'Input & Settings', effort: 'high', schema: SCHEMA })
))

return results.filter(Boolean)
