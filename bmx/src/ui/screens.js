// =============================================================================
// CONCRETE REPUBLIC — front-end and flow screens
// =============================================================================
//
// Owns every non-HUD piece of DOM: the title screen, the scripted park tour,
// controls / options / credits, the pause menu, the session results tally and
// the goal briefing card.
//
// Design rules this file follows:
//
//  * The game NEVER stops rendering. The title sits over the live park with a
//    slow cinematic orbit driven straight into `ctx.engine.camera`, and control
//    is handed back to `ctx.cameraRig` (via `snap()`) the moment a session
//    starts. main.js calls `screens.update()` after `cameraRig.update()`, so
//    whatever we write to the camera wins for that frame.
//  * Simulation is frozen with `ctx.flags.paused` while a blocking screen is up,
//    which also stops scoring.js from starting a run off menu keypresses.
//  * Everything is keyboard, gamepad and mouse navigable. Selection state and
//    DOM focus are kept in sync, and `:focus-visible` gets a real ring.
//  * Pointer events are only enabled on the screen that is actually up, so a
//    hidden menu can never eat a gameplay click.
//  * Style lives in an injected <style> scoped to `.scr-root` / `.scr-*`. It
//    borrows hud.css's type stack, palette and sizing philosophy but does not
//    touch hud.css, which another module owns.
//  * The screenshot harness (`window.__BMX.setCamera` / `harnessPose`) takes the
//    camera by replacing `cameraRig.update`. When we notice that — or a freeze /
//    freeCam flag, or a scripted input harness — this module goes dormant and
//    removes itself from the frame, without touching `ctx.flags.paused`, so
//    beauty shots are never covered by a menu.
//
// All branding is invented. No real riders, events, teams or trademarks.
// =============================================================================

import { clamp, lerp, smoothstep } from '../core/mathx.js';

// -----------------------------------------------------------------------------
// Branding + copy
// -----------------------------------------------------------------------------

const BRAND = {
  kicker: 'CITY LOT SESSIONS',
  line1: 'CONCRETE',
  line2: 'REPUBLIC',
  strap: 'BMX FREESTYLE',
  build: 'DEMO BUILD 1.0 — SINGLE MAP',
};

const MENU_TITLE = [
  { id: 'start', label: 'START SESSION', desc: '2:00 timed run — City Lot' },
  { id: 'tour', label: 'PARK TOUR', desc: 'Fly the lot, feature by feature' },
  { id: 'controls', label: 'CONTROLS', desc: 'Rebind keys, view gamepad layout' },
  { id: 'options', label: 'OPTIONS', desc: 'Quality, light, audio, HUD' },
  { id: 'credits', label: 'CREDITS', desc: 'Who built the lot' },
];

const MENU_PAUSE = [
  { id: 'resume', label: 'RESUME', desc: 'Back to the run' },
  { id: 'restart', label: 'RESTART RUN', desc: 'Reset the clock and the score' },
  { id: 'options', label: 'OPTIONS', desc: 'Quality, light, audio, HUD' },
  { id: 'quit', label: 'QUIT TO TITLE', desc: 'Abandon this session' },
];

/** Display order + human labels for the bindable actions in input.js. */
const ACTION_ROWS = [
  ['forward', 'Pedal / Lean Forward', 'ride'],
  ['back', 'Brake / Lean Back', 'ride'],
  ['left', 'Steer Left', 'ride'],
  ['right', 'Steer Right', 'ride'],
  ['pedal', 'Sprint Pedal', 'ride'],
  ['brake', 'Brake', 'ride'],
  ['hop', 'Bunnyhop / Boost', 'tricks'],
  ['trickA', 'Trick Set A — grabs', 'tricks'],
  ['trickB', 'Trick Set B — spins of the bike', 'tricks'],
  ['trickC', 'Trick Set C — flips', 'tricks'],
  ['spinLeft', 'Spin Left', 'tricks'],
  ['spinRight', 'Spin Right', 'tricks'],
  ['grind', 'Grind / Lip Trick', 'tricks'],
  ['manual', 'Manual', 'tricks'],
  ['special', 'Signature Trick', 'tricks'],
  ['reset', 'Respawn', 'system'],
  ['pause', 'Pause', 'system'],
  ['camera', 'Camera', 'system'],
  ['debug', 'Debug Overlay', 'system'],
];

const ACTION_GROUPS = [
  ['ride', 'RIDING'],
  ['tricks', 'TRICKS'],
  ['system', 'SYSTEM'],
];

/**
 * Gamepad display only — input.js keeps its pad map private and does not expose
 * a pad rebind path, so these mirror its PAD_MAP for readability.
 */
const PAD_LABEL = {
  forward: 'LS UP', back: 'LS DOWN', left: 'LS LEFT', right: 'LS RIGHT',
  pedal: 'RT', brake: 'LT',
  hop: 'A', trickA: 'X', trickB: 'Y', trickC: 'B',
  grind: 'RB', manual: 'LB',
  special: 'START', pause: 'START', reset: 'BACK', camera: 'R3',
  spinLeft: 'RS LEFT', spinRight: 'RS RIGHT', debug: '—',
};

const KEY_LABEL = {
  Space: 'SPACE', ArrowUp: 'UP', ArrowDown: 'DOWN', ArrowLeft: 'LEFT', ArrowRight: 'RIGHT',
  ShiftLeft: 'L SHIFT', ShiftRight: 'R SHIFT', ControlLeft: 'L CTRL', ControlRight: 'R CTRL',
  AltLeft: 'L ALT', AltRight: 'R ALT', Escape: 'ESC', Backquote: '`', Minus: '-', Equal: '=',
  BracketLeft: '[', BracketRight: ']', Backslash: '\\', Semicolon: ';', Quote: "'",
  Comma: ',', Period: '.', Slash: '/', Tab: 'TAB', Enter: 'ENTER', NumpadEnter: 'NUM ENTER',
  Backspace: 'BKSP', CapsLock: 'CAPS',
};

/** Scripted park flythrough. Positions are hand-authored against park.js. */
const TOUR = [
  {
    name: 'THE ROLL-IN',
    text: 'Every line starts here. Three metres of deck, a clean drop and a straight shot at the funbox.',
    from: [12.5, 7.5, 31], to: [6.5, 4.8, 26.5], look: [0, 1.6, 19.5], dur: 5.4,
  },
  {
    name: 'THE FUNBOX',
    text: 'Twin banks, a flat deck and a rail down each edge. The first place a combo turns into a line.',
    from: [-14.5, 6.4, 5.5], to: [-8.5, 4.0, 0.5], look: [0, 1.3, -6], dur: 5.2,
  },
  {
    name: 'PLAZA, STAIRS & HANDRAIL',
    text: 'Eight stairs, a kinked handrail and a hubba running out past the bottom step. Street, not park.',
    from: [27, 8.5, 15], to: [21, 5.6, 9.5], look: [14, 1.4, -0.5], dur: 5.4,
  },
  {
    name: 'THE BOWL',
    text: '3.2 metres deep in the corner, pool coping all the way round. Carve it, do not fight it.',
    from: [-16, 9.5, -3.5], to: [-22.5, 6.6, -8], look: [-30, -0.4, -14], dur: 5.6,
  },
  {
    name: 'NORTH WALL & HIP',
    text: 'A 3.6 metre quarter, a vert wall and a hip in the corner. This is where the big air lives.',
    from: [-9, 8.4, -18], to: [-6.5, 5.6, -24.5], look: [-7, 2.4, -34.5], dur: 5.4,
  },
  {
    name: 'THE SPINE',
    text: 'Twelve metres of back-to-back transition. Transfer it and the multiplier keeps climbing.',
    from: [1.5, 7.2, -6], to: [6.5, 5.0, -11], look: [12, 2.0, -16], dur: 5.0,
  },
  {
    name: 'THE WALLRIDE',
    text: 'Bank into brick, ride the wall, drop out into the flat. Four and a bit metres of nothing but tyre.',
    from: [34, 8.2, -13.5], to: [30, 5.6, -19.5], look: [24, 2.6, -26], dur: 5.2,
  },
  {
    name: 'THE MINI RAMP',
    text: 'Two facing transitions, twelve metres of flat between. Best lip trick playground in the lot.',
    from: [-19, 7.4, 27], to: [-26.5, 5.2, 21.5], look: [-32, 1.4, 16], dur: 5.2,
  },
  {
    name: 'THE DIRT LINE',
    text: 'Three doubles and a berm cut into the soil. Pull the third one and the whole run pays out.',
    from: [61, 11.5, 29], to: [55, 8.2, 20], look: [47, 2.0, 7], dur: 5.6,
  },
  {
    name: 'THE CITY LOT',
    text: 'One lot, forty-six tricks, two minutes on the clock. Go and take the top of the board.',
    from: [-49, 29, 47], to: [-40, 24.5, 40], look: [-4, 2.0, -6], dur: 6.4,
  },
];

const GRADES = [
  { min: 400000, letter: 'S', word: 'UNTOUCHABLE', cls: 'g-s' },
  { min: 250000, letter: 'A', word: 'HEADLINER', cls: 'g-a' },
  { min: 150000, letter: 'B', word: 'PRO RUN', cls: 'g-b' },
  { min: 80000, letter: 'C', word: 'SOLID', cls: 'g-c' },
  { min: 30000, letter: 'D', word: 'ROUGH', cls: 'g-d' },
  { min: 0, letter: 'E', word: 'WARM-UP', cls: 'g-e' },
];

const TOD_NAMES = [
  [0.10, 'DAWN'], [0.26, 'MORNING'], [0.46, 'MIDDAY'], [0.62, 'AFTERNOON'],
  [0.78, 'GOLDEN HOUR'], [0.90, 'DUSK'], [1.01, 'NIGHT'],
];

const QUALITY_ORDER = ['low', 'medium', 'high', 'ultra'];

const CREDITS = [
  ['DEVELOPED BY', ['Sixth Street Collective']],
  ['DESIGN & CODE', ['World & materials', 'Bike & rider rig', 'Physics & collision',
    'Tricks, grinds & scoring', 'FX, audio & interface']],
  ['BUILT WITH', ['Three.js r185', 'WebGL 2 · WebAudio', 'No downloaded assets — every mesh,'
    + ' texture and sound is generated at runtime']],
  ['RIVAL RIDERS', ['Vance Corado', 'Dez Mallory', 'Kai Brenner', 'Rook Deloso', 'Tobi Vance']],
  ['THANK YOU', ['Everyone who ever sessioned a car park at dusk']],
];

const SETTINGS_KEY = 'concreterepublic.settings.v1';

// -----------------------------------------------------------------------------
// Stylesheet (scoped to .scr-root)
// -----------------------------------------------------------------------------

const CSS = `
.scr-root{
  position:absolute; inset:0; z-index:40; pointer-events:none;
  user-select:none; -webkit-user-select:none;
  -webkit-font-smoothing:antialiased;
  --su: clamp(9px, calc(0.52vw + 0.52vh), 18px);
  --gold:#ffc434; --gold2:#ffe89a; --amber:#ff8f16; --accent:#5ad4ff;
  --red:#ff4b39; --green:#6ee87f; --violet:#c08cff;
  --ink:rgba(255,255,255,.95); --dim:rgba(255,255,255,.56); --dim2:rgba(255,255,255,.34);
  --sh:0 1px 2px rgba(0,0,0,.9), 0 0 12px rgba(0,0,0,.55);
  font-family:"Oswald","Roboto Condensed","Barlow Condensed","Archivo Narrow",
    "Liberation Sans Narrow","DejaVu Sans Condensed","Arial Narrow",
    "Franklin Gothic Medium","Impact",system-ui,"Segoe UI",sans-serif;
  font-weight:700; font-stretch:87.5%; color:var(--ink); line-height:1;
  letter-spacing:.012em; font-variant-numeric:tabular-nums lining-nums;
}
.scr-root *{box-sizing:border-box; margin:0;}
.scr-root button{
  font:inherit; color:inherit; letter-spacing:inherit; background:none;
  border:0; padding:0; cursor:pointer; text-align:left; -webkit-appearance:none; appearance:none;
}
.scr-root button:focus{outline:none;}
.scr-root button:focus-visible{outline:2px solid var(--accent); outline-offset:2px;}

/* --- blur veil (pause) --------------------------------------------------- */
.scr-veil{
  position:absolute; inset:0; opacity:0; pointer-events:none;
  background:rgba(4,6,10,.42);
  backdrop-filter:blur(13px) saturate(.82) brightness(.62);
  -webkit-backdrop-filter:blur(13px) saturate(.82) brightness(.62);
  transition:opacity 280ms ease;
}
.scr-veil.is-on{opacity:1;}

/* --- screen shell -------------------------------------------------------- */
.scr-screen{
  position:absolute; inset:0; display:flex; align-items:center; justify-content:center;
  padding:calc(var(--su)*1.6);
  opacity:0; visibility:hidden; pointer-events:none;
  transform:translateY(0.9%);
  transition:opacity 240ms ease, transform 340ms cubic-bezier(.2,.9,.25,1), visibility 0s linear 260ms;
}
.scr-screen.is-on{
  opacity:1; visibility:visible; pointer-events:auto; transform:none;
  transition:opacity 240ms ease, transform 380ms cubic-bezier(.16,1,.3,1), visibility 0s;
}
.scr-screen.no-hit{pointer-events:none !important;}
.scr-scrim{position:absolute; inset:0; pointer-events:none;}
.scr-scrim.soft{
  background:linear-gradient(180deg, rgba(3,5,9,.80) 0%, rgba(3,5,9,.30) 34%,
    rgba(3,5,9,.34) 62%, rgba(3,5,9,.86) 100%);
}
.scr-scrim.hard{background:radial-gradient(130% 100% at 50% 42%, rgba(4,6,11,.52), rgba(2,3,6,.90));}

/* --- title --------------------------------------------------------------- */
.scr-title-wrap{
  position:relative; display:flex; flex-direction:column; align-items:center;
  gap:calc(var(--su)*1.5); width:100%; max-width:calc(var(--su)*74);
}
.scr-logo{text-align:center; position:relative;}
.scr-logo-kicker{
  font-size:calc(var(--su)*1.02); letter-spacing:.52em; color:var(--gold);
  text-shadow:var(--sh); margin-left:.52em;
}
.scr-logo-rule{
  width:calc(var(--su)*16); height:1px; margin:calc(var(--su)*.55) auto;
  background:linear-gradient(90deg,rgba(255,196,52,0),rgba(255,196,52,.85),rgba(255,196,52,0));
}
.scr-logo-1,.scr-logo-2{
  font-size:calc(var(--su)*5.5); line-height:.92; letter-spacing:.015em;
  transform:skewX(-8deg) scaleX(.95); display:block;
}
.scr-logo-1{
  background:linear-gradient(180deg,#ffffff 6%,#ffeec0 44%,#ffb01c 92%);
  -webkit-background-clip:text; background-clip:text; color:transparent;
  filter:drop-shadow(0 2px 0 rgba(0,0,0,.7)) drop-shadow(0 12px 30px rgba(0,0,0,.85));
}
.scr-logo-2{
  color:rgba(255,255,255,.07);
  -webkit-text-stroke:calc(var(--su)*.11) rgba(255,255,255,.9);
  filter:drop-shadow(0 2px 0 rgba(0,0,0,.55)) drop-shadow(0 10px 26px rgba(0,0,0,.8));
}
.scr-logo-strap{
  margin-top:calc(var(--su)*.66); font-size:calc(var(--su)*1.15); letter-spacing:.44em;
  color:rgba(255,255,255,.86); text-shadow:var(--sh); margin-left:.44em;
}
.scr-screen.is-on .scr-logo-1,
.scr-screen.is-on .scr-logo-2{animation:scrLogo 720ms cubic-bezier(.16,1,.3,1) both;}
.scr-screen.is-on .scr-logo-2{animation-delay:90ms;}
@keyframes scrLogo{
  from{opacity:0; transform:skewX(-8deg) scaleX(.95) translateY(18%);}
  to{opacity:1; transform:skewX(-8deg) scaleX(.95) translateY(0);}
}

.scr-cols{display:flex; gap:calc(var(--su)*1.5); width:100%; align-items:stretch; justify-content:center;}
.scr-menu{
  flex:1 1 auto; min-width:0; max-width:calc(var(--su)*32);
  display:flex; flex-direction:column; gap:calc(var(--su)*.34);
  padding:calc(var(--su)*.9);
  background:linear-gradient(180deg,rgba(8,11,17,.60),rgba(5,7,11,.72));
  border:1px solid rgba(255,255,255,.12);
  border-left:calc(var(--su)*.18) solid rgba(255,196,52,.75);
  backdrop-filter:blur(7px) saturate(1.05); -webkit-backdrop-filter:blur(7px) saturate(1.05);
  box-shadow:0 22px 60px rgba(0,0,0,.6);
}

/* --- menu items ---------------------------------------------------------- */
.scr-item{
  position:relative; display:grid; align-items:center;
  grid-template-columns:calc(var(--su)*2.2) 1fr auto;
  gap:calc(var(--su)*.6);
  padding:calc(var(--su)*.62) calc(var(--su)*.8);
  color:rgba(255,255,255,.72);
  transition:color 140ms linear, transform 200ms cubic-bezier(.2,.9,.25,1), background 160ms linear;
}
.scr-item::before{
  content:""; position:absolute; left:0; top:0; bottom:0; width:calc(var(--su)*.2);
  background:var(--gold); transform:scaleY(0); transform-origin:center;
  transition:transform 180ms cubic-bezier(.2,.9,.25,1);
}
.scr-item.is-sel{
  color:#fff; transform:translateX(calc(var(--su)*.42));
  background:linear-gradient(90deg,rgba(255,150,20,.20),rgba(255,150,20,0) 72%);
}
.scr-item.is-sel::before{transform:scaleY(1);}
.scr-item-idx{
  font-size:calc(var(--su)*.94); letter-spacing:.1em; color:var(--dim2);
  transition:color 140ms linear;
}
.scr-item.is-sel .scr-item-idx{color:var(--gold);}
.scr-item-label{
  font-size:calc(var(--su)*1.86); letter-spacing:.055em; white-space:nowrap;
  transform:skewX(-6deg); transform-origin:left center; text-shadow:var(--sh);
  overflow:hidden; text-overflow:ellipsis;
}
.scr-item-desc{
  grid-column:2; grid-row:2; font-size:calc(var(--su)*.92); font-weight:600; font-style:italic;
  letter-spacing:.02em; color:var(--dim); white-space:nowrap; overflow:hidden; text-overflow:ellipsis;
  margin-top:calc(var(--su)*.16);
}
.scr-item.is-sel .scr-item-desc{color:rgba(255,255,255,.78);}
.scr-item-arrow{
  grid-row:1 / span 2; font-size:calc(var(--su)*1.5); color:var(--gold);
  opacity:0; transform:translateX(calc(var(--su)*-.5));
  transition:opacity 150ms linear, transform 200ms cubic-bezier(.2,.9,.25,1);
}
.scr-item.is-sel .scr-item-arrow{opacity:1; transform:translateX(0);}
.scr-screen.is-on .scr-item{animation:scrSlide 420ms cubic-bezier(.16,1,.3,1) both;
  animation-delay:calc(var(--i,0) * 55ms + 120ms);}
@keyframes scrSlide{from{opacity:0; transform:translateX(calc(var(--su)*-1.6));} to{opacity:1;}}

/* --- title side column --------------------------------------------------- */
.scr-side{
  flex:0 0 calc(var(--su)*21); display:flex; flex-direction:column; gap:calc(var(--su)*.8);
}
.scr-card{
  padding:calc(var(--su)*.75) calc(var(--su)*.85);
  background:linear-gradient(180deg,rgba(8,11,17,.62),rgba(5,7,11,.74));
  border:1px solid rgba(255,255,255,.1);
  backdrop-filter:blur(6px); -webkit-backdrop-filter:blur(6px);
}
.scr-card h3{
  font-size:calc(var(--su)*.94); letter-spacing:.24em; color:var(--gold);
  font-weight:700; margin-bottom:calc(var(--su)*.5); text-shadow:var(--sh);
}
.scr-hs-row{
  display:grid; grid-template-columns:calc(var(--su)*1.3) 1fr auto; align-items:baseline;
  gap:calc(var(--su)*.45); font-size:calc(var(--su)*1.06);
  padding:calc(var(--su)*.16) 0; color:rgba(255,255,255,.86);
}
.scr-hs-row .r{color:var(--dim2); font-size:calc(var(--su)*.92);}
.scr-hs-row .d{color:var(--dim2); font-size:calc(var(--su)*.84); font-weight:600;}
.scr-hs-row .s{color:var(--gold); justify-self:end;}
.scr-hs-row.top .s{color:var(--gold2); text-shadow:0 0 14px rgba(255,180,40,.55);}
.scr-empty{font-size:calc(var(--su)*.96); font-weight:600; font-style:italic; color:var(--dim);}
.scr-prog{display:flex; flex-direction:column; gap:calc(var(--su)*.42);}
.scr-prog-row{font-size:calc(var(--su)*.94); color:rgba(255,255,255,.8);
  display:flex; justify-content:space-between; gap:calc(var(--su)*.5);}
.scr-prog-row b{color:var(--gold); font-weight:700;}
.scr-bar{height:calc(var(--su)*.34); background:rgba(255,255,255,.12); overflow:hidden;}
.scr-bar i{display:block; height:100%; background:linear-gradient(90deg,#ff5f0a,#ffb824,#ffdf5c);
  transform-origin:left center;}

/* --- footer hints -------------------------------------------------------- */
.scr-hints{
  display:flex; flex-wrap:wrap; gap:calc(var(--su)*1.1); justify-content:center;
  font-size:calc(var(--su)*.92); letter-spacing:.1em; color:var(--dim);
  text-shadow:var(--sh);
}
.scr-hints .k{
  display:inline-flex; align-items:center; justify-content:center;
  min-width:calc(var(--su)*1.55); height:calc(var(--su)*1.45); padding:0 calc(var(--su)*.34);
  margin-right:calc(var(--su)*.36);
  font-size:calc(var(--su)*.84); color:#0c0f14;
  background:linear-gradient(180deg,#f2f5f8,#b9c2cc); border-radius:calc(var(--su)*.28);
  box-shadow:0 1px 3px rgba(0,0,0,.7), inset 0 -1px 0 rgba(0,0,0,.28); text-shadow:none;
}
.scr-build{font-size:calc(var(--su)*.82); letter-spacing:.24em; color:var(--dim2);}

/* --- panel screens ------------------------------------------------------- */
.scr-panel{
  position:relative; width:100%; max-width:calc(var(--su)*62);
  max-height:92vh; display:flex; flex-direction:column;
  background:linear-gradient(180deg,rgba(10,13,19,.93),rgba(6,8,12,.95));
  border:1px solid rgba(255,255,255,.14);
  box-shadow:0 30px 90px rgba(0,0,0,.78);
}
.scr-panel::before{
  content:""; position:absolute; left:0; right:0; top:0; height:calc(var(--su)*.16);
  background:linear-gradient(90deg,var(--amber),var(--gold) 42%,rgba(255,196,52,0));
}
.scr-panel.wide{max-width:calc(var(--su)*70);}
.scr-head{
  display:flex; align-items:baseline; gap:calc(var(--su)*.7);
  padding:calc(var(--su)*1.0) calc(var(--su)*1.1) calc(var(--su)*.72);
  border-bottom:1px solid rgba(255,255,255,.12);
}
.scr-head h2{
  font-size:calc(var(--su)*2.1); letter-spacing:.08em; transform:skewX(-7deg);
  transform-origin:left center; text-shadow:var(--sh);
}
.scr-head .sub{font-size:calc(var(--su)*.96); font-weight:600; font-style:italic; color:var(--dim);
  margin-left:auto; text-align:right;}
.scr-body{
  padding:calc(var(--su)*.7) calc(var(--su)*1.1) calc(var(--su)*.9);
  overflow-y:auto; overscroll-behavior:contain; flex:1 1 auto;
}
.scr-body::-webkit-scrollbar{width:8px;}
.scr-body::-webkit-scrollbar-thumb{background:rgba(255,255,255,.22);}
.scr-foot{
  display:flex; align-items:center; gap:calc(var(--su)*1.1); flex-wrap:wrap;
  padding:calc(var(--su)*.66) calc(var(--su)*1.1);
  border-top:1px solid rgba(255,255,255,.12);
  background:rgba(0,0,0,.28);
  font-size:calc(var(--su)*.9); letter-spacing:.1em; color:var(--dim);
}

/* --- option / control rows ---------------------------------------------- */
.scr-group{
  font-size:calc(var(--su)*.88); letter-spacing:.24em; color:var(--amber);
  padding:calc(var(--su)*.75) 0 calc(var(--su)*.3);
}
.scr-row{
  position:relative; display:grid; align-items:center;
  grid-template-columns:1fr auto; gap:calc(var(--su)*.7);
  padding:calc(var(--su)*.42) calc(var(--su)*.6);
  color:rgba(255,255,255,.78); width:100%;
  transition:background 140ms linear, color 140ms linear, transform 180ms cubic-bezier(.2,.9,.25,1);
}
.scr-row + .scr-row{border-top:1px solid rgba(255,255,255,.055);}
.scr-row.is-sel{
  color:#fff; background:linear-gradient(90deg,rgba(90,212,255,.16),rgba(90,212,255,0) 76%);
  transform:translateX(calc(var(--su)*.24));
}
.scr-row.is-sel::before{
  content:""; position:absolute; left:0; top:calc(var(--su)*.2); bottom:calc(var(--su)*.2);
  width:calc(var(--su)*.16); background:var(--accent);
}
.scr-row-label{font-size:calc(var(--su)*1.16); letter-spacing:.03em; white-space:nowrap;
  overflow:hidden; text-overflow:ellipsis;}
.scr-row-note{font-size:calc(var(--su)*.84); font-weight:600; font-style:italic; color:var(--dim);
  margin-top:calc(var(--su)*.14);}
.scr-row-val{
  display:flex; align-items:center; gap:calc(var(--su)*.55); justify-self:end;
  font-size:calc(var(--su)*1.1); color:var(--gold); white-space:nowrap;
}
.scr-row-val .arw{color:var(--dim2); font-size:calc(var(--su)*.95); transition:color 140ms linear;}
.scr-row.is-sel .arw{color:var(--accent);}
.scr-row-val .v{min-width:calc(var(--su)*7.4); text-align:center; letter-spacing:.06em;}
.scr-meter{width:calc(var(--su)*7.4); height:calc(var(--su)*.42);
  background:rgba(255,255,255,.14); overflow:hidden;}
.scr-meter i{display:block; height:100%; transform-origin:left center;
  background:linear-gradient(90deg,#ff5f0a,#ffb824);}
.scr-keys{display:flex; gap:calc(var(--su)*.3); align-items:center;}
.scr-key{
  display:inline-flex; align-items:center; justify-content:center;
  min-width:calc(var(--su)*2.3); height:calc(var(--su)*1.55); padding:0 calc(var(--su)*.4);
  font-size:calc(var(--su)*.86); letter-spacing:.06em; color:#0c0f14;
  background:linear-gradient(180deg,#eef2f6,#b4bec8); border-radius:calc(var(--su)*.24);
  box-shadow:0 1px 2px rgba(0,0,0,.7), inset 0 -1px 0 rgba(0,0,0,.3);
}
.scr-key.alt{background:linear-gradient(180deg,#8e99a5,#69737d); color:#0b0e12;}
.scr-key.pad{
  background:none; color:var(--accent); border:1px solid rgba(90,212,255,.5);
  box-shadow:none; min-width:calc(var(--su)*3.0);
}
.scr-row.is-binding{background:linear-gradient(90deg,rgba(255,150,20,.28),rgba(255,150,20,0) 76%);}
.scr-row.is-binding .scr-keys{display:none;}
.scr-bindmsg{display:none; font-size:calc(var(--su)*1.0); letter-spacing:.14em; color:var(--gold);
  animation:scrBlink .82s steps(2,end) infinite;}
.scr-row.is-binding .scr-bindmsg{display:inline;}
@keyframes scrBlink{50%{opacity:.25;}}

/* --- credits ------------------------------------------------------------- */
.scr-cred-sec{padding:calc(var(--su)*.55) 0;}
.scr-cred-sec h4{font-size:calc(var(--su)*.88); letter-spacing:.26em; color:var(--amber);
  margin-bottom:calc(var(--su)*.3);}
.scr-cred-sec p{font-size:calc(var(--su)*1.06); font-weight:600; color:rgba(255,255,255,.86);
  padding:calc(var(--su)*.1) 0;}
.scr-cred-note{margin-top:calc(var(--su)*.9); font-size:calc(var(--su)*.9); font-weight:600;
  font-style:italic; color:var(--dim); line-height:1.5;}

/* --- tour ---------------------------------------------------------------- */
.scr-tour{align-items:flex-end; justify-content:flex-start;}
.scr-tour-cap{
  position:relative; max-width:calc(var(--su)*34);
  margin:0 0 calc(var(--su)*2.4) calc(var(--su)*1.4);
  padding:calc(var(--su)*.8) calc(var(--su)*1.0);
  background:linear-gradient(90deg,rgba(6,9,14,.86),rgba(6,9,14,.42));
  border-left:calc(var(--su)*.2) solid var(--gold);
}
.scr-tour-kicker{font-size:calc(var(--su)*.86); letter-spacing:.3em; color:var(--gold);}
.scr-tour-name{font-size:calc(var(--su)*2.2); letter-spacing:.05em; transform:skewX(-7deg);
  transform-origin:left center; margin:calc(var(--su)*.3) 0; text-shadow:var(--sh);}
.scr-tour-text{font-size:calc(var(--su)*1.02); font-weight:600; font-style:italic;
  color:rgba(255,255,255,.84); line-height:1.42;}
.scr-tour-cap.flip{animation:scrCap 520ms cubic-bezier(.16,1,.3,1);}
@keyframes scrCap{from{opacity:0; transform:translateX(calc(var(--su)*-1.2));} to{opacity:1; transform:none;}}
.scr-tour-dots{
  position:absolute; left:calc(var(--su)*1.4); bottom:calc(var(--su)*1.3);
  display:flex; gap:calc(var(--su)*.34);
}
.scr-tour-dots i{width:calc(var(--su)*1.5); height:calc(var(--su)*.2);
  background:rgba(255,255,255,.22); display:block;}
.scr-tour-dots i.on{background:var(--gold); box-shadow:0 0 8px rgba(255,196,52,.7);}
.scr-tour-skip{
  position:absolute; right:calc(var(--su)*1.6); bottom:calc(var(--su)*1.6);
  font-size:calc(var(--su)*.94); letter-spacing:.14em; color:var(--dim);
}
.scr-tour-bars::before,.scr-tour-bars::after{
  content:""; position:absolute; left:0; right:0; height:calc(var(--su)*2.6);
  background:#04060a; pointer-events:none;
}
.scr-tour-bars::before{top:0;} .scr-tour-bars::after{bottom:0;}

/* --- results ------------------------------------------------------------- */
.scr-res{max-width:calc(var(--su)*56); overflow-y:auto; overscroll-behavior:contain;}
.scr-res::-webkit-scrollbar{width:8px;}
.scr-res::-webkit-scrollbar-thumb{background:rgba(255,255,255,.22);}
.scr-res-top{
  display:flex; align-items:center; gap:calc(var(--su)*1.1);
  padding:calc(var(--su)*1.0) calc(var(--su)*1.2) calc(var(--su)*.6);
}
.scr-res-title{flex:1 1 auto; min-width:0;}
.scr-res-title h2{font-size:calc(var(--su)*2.3); letter-spacing:.08em; transform:skewX(-7deg);
  transform-origin:left center; text-shadow:var(--sh);}
.scr-res-title .sub{font-size:calc(var(--su)*1.0); font-weight:600; font-style:italic; color:var(--dim);
  margin-top:calc(var(--su)*.24);}
.scr-grade{
  flex:0 0 auto; width:calc(var(--su)*5.4); height:calc(var(--su)*5.4);
  display:flex; flex-direction:column; align-items:center; justify-content:center;
  border:calc(var(--su)*.14) solid var(--gold); background:rgba(255,150,20,.10);
  opacity:0; transform:scale(1.7) rotate(-8deg);
}
.scr-grade.in{animation:scrGrade 520ms cubic-bezier(.16,1,.3,1) forwards;}
@keyframes scrGrade{
  0%{opacity:0; transform:scale(1.8) rotate(-10deg);}
  60%{opacity:1; transform:scale(.94) rotate(0);}
  100%{opacity:1; transform:scale(1) rotate(0);}
}
.scr-grade .l{font-size:calc(var(--su)*3.1); line-height:1; color:var(--gold);
  text-shadow:0 0 26px rgba(255,170,40,.7);}
.scr-grade .w{font-size:calc(var(--su)*.7); letter-spacing:.16em; color:rgba(255,255,255,.82);
  margin-top:calc(var(--su)*.2);}
.scr-grade.g-s{border-color:var(--violet); background:rgba(180,120,255,.12);}
.scr-grade.g-s .l{color:var(--violet); text-shadow:0 0 28px rgba(180,120,255,.8);}
.scr-grade.g-a{border-color:var(--gold);}
.scr-grade.g-b{border-color:var(--accent); background:rgba(90,212,255,.1);}
.scr-grade.g-b .l{color:var(--accent); text-shadow:0 0 24px rgba(90,212,255,.7);}
.scr-grade.g-c,.scr-grade.g-d{border-color:rgba(255,255,255,.5); background:rgba(255,255,255,.05);}
.scr-grade.g-c .l,.scr-grade.g-d .l{color:#fff; text-shadow:var(--sh);}
.scr-grade.g-e{border-color:rgba(255,75,57,.6); background:rgba(255,75,57,.08);}
.scr-grade.g-e .l{color:var(--red);}

.scr-tally{padding:0 calc(var(--su)*1.2);}
.scr-tally-row{
  display:grid; grid-template-columns:1fr auto; align-items:baseline;
  gap:calc(var(--su)*.8); padding:calc(var(--su)*.34) 0;
  border-bottom:1px solid rgba(255,255,255,.07);
  opacity:0; transform:translateY(28%);
}
.scr-tally-row.in{animation:scrTally 340ms cubic-bezier(.16,1,.3,1) forwards;}
@keyframes scrTally{to{opacity:1; transform:none;}}
.scr-tally-row .l{font-size:calc(var(--su)*1.08); letter-spacing:.08em; color:rgba(255,255,255,.78);}
.scr-tally-row .v{font-size:calc(var(--su)*1.42); color:#fff; text-shadow:var(--sh);}
.scr-tally-row .v .u{font-size:calc(var(--su)*.86); color:var(--dim); margin-left:.24em;}
.scr-tally-row.final{border-bottom:0; margin-top:calc(var(--su)*.5);
  padding-top:calc(var(--su)*.6); border-top:1px solid rgba(255,255,255,.2);}
.scr-tally-row.final .l{font-size:calc(var(--su)*1.5); color:#fff;}
.scr-tally-row.final .v{font-size:calc(var(--su)*3.0); color:var(--gold);
  text-shadow:0 2px 4px rgba(0,0,0,.95), 0 0 26px rgba(255,150,20,.5);}
.scr-newhigh{
  margin:calc(var(--su)*.6) calc(var(--su)*1.2) 0; padding:calc(var(--su)*.42) calc(var(--su)*.7);
  text-align:center; font-size:calc(var(--su)*1.22); letter-spacing:.22em;
  color:#1a1206; background:linear-gradient(90deg,#ff8f16,#ffdf5c,#ff8f16);
  display:none;
}
.scr-newhigh.on{display:block; animation:scrHigh 1.1s ease-in-out infinite alternate;}
@keyframes scrHigh{from{filter:brightness(1);} to{filter:brightness(1.35);}}
.scr-strip{
  display:flex; flex-wrap:wrap; gap:calc(var(--su)*1.0);
  padding:calc(var(--su)*.7) calc(var(--su)*1.2) calc(var(--su)*.2);
  font-size:calc(var(--su)*.92); color:var(--dim);
}
.scr-strip b{color:rgba(255,255,255,.9); font-weight:700;}
.scr-res-btns{
  display:flex; gap:calc(var(--su)*.7); padding:calc(var(--su)*.9) calc(var(--su)*1.2) calc(var(--su)*1.1);
}
.scr-btn{
  flex:1 1 0; text-align:center; padding:calc(var(--su)*.72) calc(var(--su)*.9);
  font-size:calc(var(--su)*1.32); letter-spacing:.1em;
  border:1px solid rgba(255,255,255,.24); color:rgba(255,255,255,.82);
  background:linear-gradient(180deg,rgba(255,255,255,.06),rgba(255,255,255,.01));
  transition:color 140ms linear, border-color 140ms linear, background 140ms linear,
    transform 180ms cubic-bezier(.2,.9,.25,1);
}
.scr-btn.is-sel{
  color:#12151b; border-color:var(--gold2);
  background:linear-gradient(180deg,var(--gold2),var(--gold));
  transform:translateY(calc(var(--su)*-.12));
  box-shadow:0 calc(var(--su)*.3) calc(var(--su)*1.1) rgba(255,150,20,.32);
}

/* --- goal briefing ------------------------------------------------------- */
.scr-brief{
  align-items:flex-start; justify-content:center; padding-top:12vh; pointer-events:none;
}
.scr-brief-card{
  width:100%; max-width:calc(var(--su)*44);
  padding:calc(var(--su)*.9) calc(var(--su)*1.1) calc(var(--su)*1.0);
  background:linear-gradient(180deg,rgba(8,11,17,.88),rgba(5,7,11,.80));
  border:1px solid rgba(255,255,255,.14);
  border-top:calc(var(--su)*.16) solid var(--gold);
  box-shadow:0 22px 60px rgba(0,0,0,.65);
  backdrop-filter:blur(4px); -webkit-backdrop-filter:blur(4px);
}
.scr-brief-head{display:flex; align-items:baseline; gap:calc(var(--su)*.7);
  margin-bottom:calc(var(--su)*.6);}
.scr-brief-head h2{font-size:calc(var(--su)*1.7); letter-spacing:.1em; transform:skewX(-7deg);
  transform-origin:left center;}
.scr-brief-head .sub{margin-left:auto; font-size:calc(var(--su)*.92); letter-spacing:.18em;
  color:var(--gold);}
.scr-brief-list{
  display:grid; grid-template-columns:repeat(auto-fit,minmax(calc(var(--su)*17),1fr));
  gap:calc(var(--su)*.22) calc(var(--su)*1.0);
}
.scr-brief-goal{
  display:grid; grid-template-columns:calc(var(--su)*1.0) 1fr; align-items:center;
  gap:calc(var(--su)*.45); font-size:calc(var(--su)*.98); font-weight:600;
  color:rgba(255,255,255,.82); padding:calc(var(--su)*.12) 0;
}
.scr-brief-goal i{
  width:calc(var(--su)*.58); height:calc(var(--su)*.58); justify-self:center;
  border:1px solid rgba(255,255,255,.45);
}
.scr-brief-goal.done i{background:var(--green); border-color:var(--green);
  box-shadow:0 0 8px rgba(110,232,127,.65);}
.scr-brief-goal.done{color:rgba(110,232,127,.85);}
.scr-brief-foot{margin-top:calc(var(--su)*.7); font-size:calc(var(--su)*.9); font-style:italic;
  font-weight:600; color:var(--dim);}
.scr-screen.is-on .scr-brief-card{animation:scrBrief 420ms cubic-bezier(.16,1,.3,1) both;}
@keyframes scrBrief{from{opacity:0; transform:translateY(calc(var(--su)*-1.2));} to{opacity:1;}}

/* --- narrow / short viewports ------------------------------------------- */
@media (max-width:940px){ .scr-side{display:none;} }
@media (max-height:560px){
  .scr-logo-1,.scr-logo-2{font-size:calc(var(--su)*3.8);}
  .scr-item-desc{display:none;}
  .scr-side{display:none;}
}
@media (prefers-reduced-motion: reduce){
  .scr-root *{animation-duration:.001ms !important; transition-duration:.001ms !important;}
}
`;

// -----------------------------------------------------------------------------
// Small helpers
// -----------------------------------------------------------------------------

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

/** 37850 -> "37,850", locale-independent. */
function fmt(n) {
  let v = Math.round(n);
  if (!Number.isFinite(v)) v = 0;
  const neg = v < 0;
  if (neg) v = -v;
  let s = String(v);
  if (s.length > 3) {
    let out = '';
    let c = 0;
    for (let i = s.length - 1; i >= 0; i--) {
      out = s[i] + out;
      if (++c % 3 === 0 && i > 0) out = ',' + out;
    }
    s = out;
  }
  return neg ? '-' + s : s;
}

function keyLabel(code) {
  if (!code) return '—';
  if (KEY_LABEL[code]) return KEY_LABEL[code];
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  if (code.startsWith('Numpad')) return 'NUM ' + code.slice(6).toUpperCase();
  return code.toUpperCase();
}

function todName(t) {
  for (let i = 0; i < TOD_NAMES.length; i++) if (t < TOD_NAMES[i][0]) return TOD_NAMES[i][1];
  return TOD_NAMES[TOD_NAMES.length - 1][1];
}

function gradeFor(score) {
  for (let i = 0; i < GRADES.length; i++) if (score >= GRADES[i].min) return GRADES[i];
  return GRADES[GRADES.length - 1];
}

const easeOut = (t) => 1 - (1 - t) * (1 - t) * (1 - t);

// =============================================================================

export function createScreens(ctx) {
  // ---------------------------------------------------------------- settings

  const settings = {
    quality: ctx.engine?.tier?.name || 'high',
    timeOfDay: typeof ctx.world?.environment?.timeOfDay === 'number'
      ? ctx.world.environment.timeOfDay : 0.72,
    volume: typeof ctx.audio?.volume === 'number' ? clamp(ctx.audio.volume, 0, 1) : 0.85,
    invert: false,
    hudScale: 1,
    binds: null,
  };

  const defaultBinds = {};
  const rawBinds = ctx.input?.binds || {};
  for (const k of Object.keys(rawBinds)) defaultBinds[k] = rawBinds[k].slice();

  function loadSettings() {
    let raw = null;
    try { raw = globalThis.localStorage?.getItem(SETTINGS_KEY); } catch (err) { raw = null; }
    if (!raw) return;
    let data = null;
    try { data = JSON.parse(raw); } catch (err) { return; }
    if (!data || typeof data !== 'object') return;
    if (QUALITY_ORDER.indexOf(data.quality) >= 0) settings.quality = data.quality;
    if (Number.isFinite(data.timeOfDay)) settings.timeOfDay = clamp(data.timeOfDay, 0, 1);
    if (Number.isFinite(data.volume)) settings.volume = clamp(data.volume, 0, 1);
    if (Number.isFinite(data.hudScale)) settings.hudScale = clamp(data.hudScale, 0.7, 1.4);
    settings.invert = !!data.invert;
    if (data.binds && typeof data.binds === 'object') settings.binds = data.binds;
  }

  function saveSettings() {
    const binds = {};
    const b = ctx.input?.binds || {};
    for (const k of Object.keys(b)) binds[k] = b[k].slice();
    settings.binds = binds;
    try {
      globalThis.localStorage?.setItem(SETTINGS_KEY, JSON.stringify(settings));
    } catch (err) { /* storage unavailable — settings stay session-only */ }
  }

  loadSettings();

  function applyQuality() {
    ctx.engine?.setQuality?.(settings.quality);
  }
  function applyTimeOfDay() {
    ctx.world?.environment?.setTimeOfDay?.(settings.timeOfDay);
  }
  function applyVolume() {
    const a = ctx.audio;
    if (!a) return;
    try {
      if (typeof a.setMasterVolume === 'function') a.setMasterVolume(settings.volume);
      else if (typeof a.setVolume === 'function') a.setVolume(settings.volume);
      else if (typeof a.setMaster === 'function') a.setMaster(settings.volume);
      else if (Object.getOwnPropertyDescriptor(a, 'volume')?.writable) a.volume = settings.volume;
      const wantMute = settings.volume <= 0.001;
      if (typeof a.mute === 'function' && !!a.muted !== wantMute) a.mute(wantMute);
      else if (typeof a.setMuted === 'function') a.setMuted(wantMute);
    } catch (err) { /* audio module shape differs — volume stays where it was */ }
  }
  function applyInvert() {
    if (ctx.flags) ctx.flags.invertCamera = settings.invert;
    ctx.cameraRig?.setInvert?.(settings.invert);
  }
  function applyHudScale() {
    const hudEl = ctx.hud?.root || document.querySelector('.hud');
    if (!hudEl) return;
    const s = settings.hudScale;
    hudEl.style.setProperty('--u',
      'clamp(' + (10 * s).toFixed(2) + 'px, calc((0.55vw + 0.55vh) * ' + s.toFixed(3) + '), '
      + (20 * s).toFixed(2) + 'px)');
  }
  function applyBinds() {
    const saved = settings.binds;
    if (!saved || !ctx.input?.setBind) return;
    for (const action of Object.keys(defaultBinds)) {
      const keys = saved[action];
      if (!Array.isArray(keys) || !keys.length) continue;
      const clean = [];
      for (let i = 0; i < keys.length; i++) {
        if (typeof keys[i] === 'string' && clean.indexOf(keys[i]) < 0) clean.push(keys[i]);
      }
      if (clean.length) ctx.input.setBind(action, clean);
    }
  }

  // Restoring saved settings pokes four sibling modules. None of them may ever
  // be able to take the boot down with it.
  function applyAll() {
    const steps = [applyBinds, applyQuality, applyTimeOfDay, applyVolume, applyInvert, applyHudScale];
    for (let i = 0; i < steps.length; i++) {
      try { steps[i](); } catch (err) { console.warn('[screens] setting failed:', err?.message || err); }
    }
  }
  applyAll();

  // ------------------------------------------------------------------- style

  let styleEl = document.getElementById('scr-style');
  if (!styleEl) {
    styleEl = document.createElement('style');
    styleEl.id = 'scr-style';
    styleEl.textContent = CSS;
    document.head.appendChild(styleEl);
  }

  // -------------------------------------------------------------------- DOM

  const mount = document.getElementById('ui-root') || document.body;
  const root = el('div', 'scr-root');
  const veil = el('div', 'scr-veil');
  root.appendChild(veil);
  mount.appendChild(root);

  /** id -> { el, items[], sel, activate(i), adjust(i,dir), onOpen(), onClose(), back } */
  const screens = Object.create(null);

  function makeScreen(id, cls) {
    const node = el('div', 'scr-screen' + (cls ? ' ' + cls : ''));
    node.dataset.screen = id;
    root.appendChild(node);
    const rec = {
      id, el: node, items: [], sel: 0,
      activate: null, adjust: null, onOpen: null, onClose: null, back: null,
    };
    screens[id] = rec;
    return rec;
  }

  function hintRow(pairs) {
    const wrap = el('div', 'scr-hints');
    for (let i = 0; i < pairs.length; i++) {
      const g = el('span');
      const k = el('span', 'k', pairs[i][0]);
      g.appendChild(k);
      g.appendChild(document.createTextNode(pairs[i][1]));
      wrap.appendChild(g);
    }
    return wrap;
  }

  function menuButton(rec, def, index) {
    const b = el('button', 'scr-item');
    b.type = 'button';
    b.style.setProperty('--i', String(index));
    b.appendChild(el('span', 'scr-item-idx', String(index + 1).padStart(2, '0')));
    b.appendChild(el('span', 'scr-item-label', def.label));
    b.appendChild(el('span', 'scr-item-desc', def.desc));
    b.appendChild(el('span', 'scr-item-arrow', '▸'));
    b.addEventListener('click', () => { select(rec, index); doActivate(); });
    b.addEventListener('pointerenter', () => select(rec, index));
    rec.items.push(b);
    return b;
  }

  // ======================================================================
  // TITLE
  // ======================================================================

  const title = makeScreen('title');
  title.el.appendChild(el('div', 'scr-scrim soft'));
  {
    const wrap = el('div', 'scr-title-wrap');

    const logo = el('div', 'scr-logo');
    logo.appendChild(el('div', 'scr-logo-kicker', BRAND.kicker));
    logo.appendChild(el('div', 'scr-logo-rule'));
    logo.appendChild(el('div', 'scr-logo-1', BRAND.line1));
    logo.appendChild(el('div', 'scr-logo-2', BRAND.line2));
    logo.appendChild(el('div', 'scr-logo-strap', BRAND.strap));
    wrap.appendChild(logo);

    const cols = el('div', 'scr-cols');
    const menu = el('nav', 'scr-menu');
    menu.setAttribute('aria-label', 'Main menu');
    for (let i = 0; i < MENU_TITLE.length; i++) menu.appendChild(menuButton(title, MENU_TITLE[i], i));
    cols.appendChild(menu);

    const side = el('div', 'scr-side');
    const hsCard = el('div', 'scr-card');
    hsCard.appendChild(el('h3', null, 'TOP SCORES'));
    const hsList = el('div');
    hsCard.appendChild(hsList);
    side.appendChild(hsCard);

    const prCard = el('div', 'scr-card');
    prCard.appendChild(el('h3', null, 'CAREER'));
    const prList = el('div', 'scr-prog');
    prCard.appendChild(prList);
    side.appendChild(prCard);
    cols.appendChild(side);
    wrap.appendChild(cols);

    wrap.appendChild(hintRow([
      ['W/S', 'NAVIGATE'], ['ENTER', 'SELECT'], ['ESC', 'BACK'], ['PAD', 'D-PAD + A'],
    ]));
    wrap.appendChild(el('div', 'scr-build', BRAND.build));
    title.el.appendChild(wrap);

    title.activate = (i) => {
      const id = MENU_TITLE[i].id;
      if (id === 'start') startSession();
      else if (id === 'tour') setState('tour');
      else openSub(id);
    };

    // --- side column refresh ------------------------------------------------
    const progRows = [];
    function progRow(label) {
      const row = el('div');
      const head = el('div', 'scr-prog-row');
      const l = el('span', null, label);
      const v = el('b', null, '0 / 0');
      head.appendChild(l);
      head.appendChild(v);
      const bar = el('div', 'scr-bar');
      const fill = el('i');
      fill.style.transform = 'scaleX(0)';
      bar.appendChild(fill);
      row.appendChild(head);
      row.appendChild(bar);
      prList.appendChild(row);
      const rec = { v, fill };
      progRows.push(rec);
      return rec;
    }
    const progTricks = progRow('TRICK LIST');
    const progGoals = progRow('CHALLENGES');
    const progAch = progRow('ACHIEVEMENTS');

    title.onOpen = () => {
      const sc = ctx.player?.scoring;
      // --- high scores ---
      while (hsList.firstChild) hsList.removeChild(hsList.firstChild);
      const list = (sc?.profile?.scores) || sc?.highScores || [];
      if (!list.length) {
        hsList.appendChild(el('div', 'scr-empty', 'No runs on record. Go and set one.'));
      } else {
        for (let i = 0; i < Math.min(5, list.length); i++) {
          const r = list[i];
          const row = el('div', 'scr-hs-row' + (i === 0 ? ' top' : ''));
          row.appendChild(el('span', 'r', String(i + 1)));
          row.appendChild(el('span', 'd', r.date || 'THIS SESSION'));
          row.appendChild(el('span', 's', fmt(r.score || 0)));
          hsList.appendChild(row);
        }
      }
      // --- progress ---
      const landed = sc?.landedCount || 0;
      const total = sc?.totalCount || 46;
      const goalsDone = (sc?.profile?.goals?.length) || 0;
      const goalsTotal = (sc?.goals?.length) || 9;
      let ach = 0;
      const achs = sc?.achievements || [];
      for (let i = 0; i < achs.length; i++) if (achs[i].unlocked) ach++;
      const set = (rec, a, b) => {
        rec.v.textContent = a + ' / ' + b;
        rec.fill.style.transform = 'scaleX(' + (b > 0 ? clamp(a / b, 0, 1).toFixed(3) : '0') + ')';
      };
      set(progTricks, landed, total);
      set(progGoals, goalsDone, goalsTotal);
      set(progAch, ach, achs.length || 16);
    };
    void progRows;
  }

  // ======================================================================
  // PARK TOUR
  // ======================================================================

  const tour = makeScreen('tour', 'scr-tour scr-tour-bars');
  const tourCap = el('div', 'scr-tour-cap');
  const tourName = el('div', 'scr-tour-name', '');
  const tourText = el('div', 'scr-tour-text', '');
  tourCap.appendChild(el('div', 'scr-tour-kicker', 'CITY LOT — FEATURE TOUR'));
  tourCap.appendChild(tourName);
  tourCap.appendChild(tourText);
  tour.el.appendChild(tourCap);
  const tourDots = el('div', 'scr-tour-dots');
  const tourDotEls = [];
  for (let i = 0; i < TOUR.length; i++) {
    const d = el('i');
    tourDots.appendChild(d);
    tourDotEls.push(d);
  }
  tour.el.appendChild(tourDots);
  tour.el.appendChild(el('div', 'scr-tour-skip', 'ENTER / ESC — SKIP'));
  tour.back = 'title';

  let tourIndex = -1;
  let tourT = 0;

  function tourGoto(i) {
    tourIndex = i;
    tourT = 0;
    const s = TOUR[i];
    tourName.textContent = s.name;
    tourText.textContent = s.text;
    tourCap.classList.remove('flip');
    void tourCap.offsetWidth;
    tourCap.classList.add('flip');
    for (let k = 0; k < tourDotEls.length; k++) tourDotEls[k].classList.toggle('on', k <= i);
  }

  tour.onOpen = () => { tourGoto(0); };
  tour.activate = () => { setState('title'); };

  // ======================================================================
  // CONTROLS
  // ======================================================================

  const controls = makeScreen('controls');
  controls.el.appendChild(el('div', 'scr-scrim hard'));
  controls.back = 'title';
  const bindRows = [];
  let bindingRow = null;
  {
    const panel = el('div', 'scr-panel wide');
    const head = el('div', 'scr-head');
    head.appendChild(el('h2', null, 'CONTROLS'));
    head.appendChild(el('div', 'sub', 'Click a row or press Enter to rebind'));
    panel.appendChild(head);

    const body = el('div', 'scr-body');
    const seen = Object.create(null);
    for (let i = 0; i < ACTION_ROWS.length; i++) {
      if (ACTION_ROWS[i][0] in rawBinds) seen[ACTION_ROWS[i][0]] = true;
    }
    // Anything input.js declares that we did not list explicitly.
    const extra = [];
    for (const action of Object.keys(rawBinds)) if (!seen[action]) extra.push(action);

    const buildRow = (action, label) => {
      const b = el('button', 'scr-row');
      b.type = 'button';
      const left = el('div');
      left.appendChild(el('div', 'scr-row-label', label));
      left.appendChild(el('div', 'scr-row-note', 'Gamepad: ' + (PAD_LABEL[action] || '—')));
      const right = el('div', 'scr-row-val');
      const keys = el('div', 'scr-keys');
      right.appendChild(keys);
      right.appendChild(el('span', 'scr-bindmsg', 'PRESS A KEY…'));
      const pad = el('span', 'scr-key pad', PAD_LABEL[action] || '—');
      right.appendChild(pad);
      b.appendChild(left);
      b.appendChild(right);
      const index = controls.items.length;
      b.addEventListener('click', () => { select(controls, index); doActivate(); });
      b.addEventListener('pointerenter', () => select(controls, index));
      controls.items.push(b);
      const rec = { action, el: b, keys };
      bindRows.push(rec);
      return b;
    };

    // Group header, then that group's rows, in declaration order.
    for (let g = 0; g < ACTION_GROUPS.length; g++) {
      const groupId = ACTION_GROUPS[g][0];
      let added = false;
      for (let i = 0; i < ACTION_ROWS.length; i++) {
        const [action, label, grp] = ACTION_ROWS[i];
        if (grp !== groupId || !(action in rawBinds)) continue;
        if (!added) { body.appendChild(el('div', 'scr-group', ACTION_GROUPS[g][1])); added = true; }
        body.appendChild(buildRow(action, label));
      }
    }
    if (extra.length) {
      body.appendChild(el('div', 'scr-group', 'OTHER'));
      for (let i = 0; i < extra.length; i++) body.appendChild(buildRow(extra[i], extra[i]));
    }

    // Reset row
    body.appendChild(el('div', 'scr-group', ' '));
    const resetBtn = el('button', 'scr-row');
    resetBtn.type = 'button';
    const rl = el('div');
    rl.appendChild(el('div', 'scr-row-label', 'RESTORE DEFAULT BINDINGS'));
    rl.appendChild(el('div', 'scr-row-note', 'Puts every key back to the shipped layout'));
    resetBtn.appendChild(rl);
    const rv = el('div', 'scr-row-val');
    rv.appendChild(el('span', 'v', 'RESET'));
    resetBtn.appendChild(rv);
    const resetIndex = controls.items.length;
    resetBtn.addEventListener('click', () => { select(controls, resetIndex); doActivate(); });
    resetBtn.addEventListener('pointerenter', () => select(controls, resetIndex));
    controls.items.push(resetBtn);
    body.appendChild(resetBtn);

    panel.appendChild(body);
    const foot = el('div', 'scr-foot');
    foot.appendChild(hintRow([['ENTER', 'REBIND'], ['ESC', 'BACK / CANCEL']]));
    panel.appendChild(foot);
    controls.el.appendChild(panel);

    controls.activate = (i) => {
      if (i === resetIndex) {
        for (const action of Object.keys(defaultBinds)) {
          ctx.input?.setBind?.(action, defaultBinds[action].slice());
        }
        refreshBinds();
        saveSettings();
        sfx('uiBack');
        return;
      }
      startRebind(bindRows[i]);
    };
    controls.onClose = () => cancelRebind();
    controls.onOpen = () => refreshBinds();
  }

  function refreshBinds() {
    const b = ctx.input?.binds || {};
    for (let i = 0; i < bindRows.length; i++) {
      const rec = bindRows[i];
      const keys = b[rec.action] || [];
      while (rec.keys.firstChild) rec.keys.removeChild(rec.keys.firstChild);
      if (!keys.length) {
        rec.keys.appendChild(el('span', 'scr-key alt', '—'));
      } else {
        for (let k = 0; k < Math.min(keys.length, 3); k++) {
          rec.keys.appendChild(el('span', 'scr-key' + (k ? ' alt' : ''), keyLabel(keys[k])));
        }
      }
    }
  }

  function startRebind(rec) {
    if (!rec) return;
    cancelRebind();
    bindingRow = rec;
    rec.el.classList.add('is-binding');
    sfx('uiSelect');
  }

  function cancelRebind() {
    if (!bindingRow) return;
    bindingRow.el.classList.remove('is-binding');
    bindingRow = null;
  }

  function commitRebind(code) {
    if (!bindingRow) return;
    const action = bindingRow.action;
    const cur = (ctx.input?.binds?.[action] || []).slice();
    const next = [code];
    for (let i = 1; i < cur.length; i++) if (cur[i] !== code) next.push(cur[i]);
    ctx.input?.setBind?.(action, next);
    cancelRebind();
    refreshBinds();
    saveSettings();
    sfx('uiSelect');
  }

  // ======================================================================
  // OPTIONS
  // ======================================================================

  const options = makeScreen('options');
  options.el.appendChild(el('div', 'scr-scrim hard'));
  options.back = 'title';
  const optRows = [];
  {
    const panel = el('div', 'scr-panel');
    const head = el('div', 'scr-head');
    head.appendChild(el('h2', null, 'OPTIONS'));
    head.appendChild(el('div', 'sub', 'Left / Right to change'));
    panel.appendChild(head);
    const body = el('div', 'scr-body');

    const addRow = (label, note, opts) => {
      const b = el('button', 'scr-row');
      b.type = 'button';
      const left = el('div');
      left.appendChild(el('div', 'scr-row-label', label));
      left.appendChild(el('div', 'scr-row-note', note));
      const right = el('div', 'scr-row-val');
      right.appendChild(el('span', 'arw', '◂'));
      const v = el('span', 'v', '');
      right.appendChild(v);
      let meterFill = null;
      if (opts && opts.meter) {
        const m = el('div', 'scr-meter');
        meterFill = el('i');
        m.appendChild(meterFill);
        right.appendChild(m);
      }
      right.appendChild(el('span', 'arw', '▸'));
      b.appendChild(left);
      b.appendChild(right);
      const index = options.items.length;
      b.addEventListener('click', () => { select(options, index); doAdjust(1); });
      b.addEventListener('pointerenter', () => select(options, index));
      options.items.push(b);
      body.appendChild(b);
      const rec = { v, meterFill, step: opts.step, text: opts.text, meterValue: opts.meterValue || null };
      optRows.push(rec);
      return rec;
    };

    addRow('QUALITY', 'Resolution scale, shadows, ambient occlusion, bloom', {
      step: (dir) => {
        const i = QUALITY_ORDER.indexOf(settings.quality);
        const n = clamp((i < 0 ? 2 : i) + dir, 0, QUALITY_ORDER.length - 1);
        settings.quality = QUALITY_ORDER[n];
        applyQuality();
      },
      text: () => settings.quality.toUpperCase(),
    });
    addRow('TIME OF DAY', 'Sun elevation, cloud break and practical lights', {
      meter: true,
      step: (dir) => {
        settings.timeOfDay = clamp(settings.timeOfDay + dir * 0.04, 0, 1);
        applyTimeOfDay();
      },
      text: () => todName(settings.timeOfDay),
      meterValue: () => settings.timeOfDay,
    });
    addRow('MASTER VOLUME', 'Everything: tyres, grinds, crowd and music', {
      meter: true,
      step: (dir) => {
        settings.volume = clamp(settings.volume + dir * 0.1, 0, 1);
        applyVolume();
      },
      text: () => (settings.volume <= 0.001 ? 'MUTE' : Math.round(settings.volume * 100) + '%'),
      meterValue: () => settings.volume,
    });
    addRow('INVERT CAMERA', 'Flip the vertical look axis on the right stick', {
      step: () => { settings.invert = !settings.invert; applyInvert(); },
      text: () => (settings.invert ? 'ON' : 'OFF'),
    });
    addRow('HUD SCALE', 'Size of the score, timer and trick callout', {
      meter: true,
      step: (dir) => {
        settings.hudScale = clamp(settings.hudScale + dir * 0.05, 0.7, 1.4);
        applyHudScale();
      },
      text: () => Math.round(settings.hudScale * 100) + '%',
      meterValue: () => clamp((settings.hudScale - 0.7) / 0.7, 0, 1),
    });

    panel.appendChild(body);
    const foot = el('div', 'scr-foot');
    foot.appendChild(hintRow([['A/D', 'CHANGE'], ['ESC', 'BACK']]));
    panel.appendChild(foot);
    options.el.appendChild(panel);

    options.adjust = (i, dir) => {
      const rec = optRows[i];
      if (!rec) return;
      rec.step(dir);
      refreshOptions();
      saveSettings();
    };
    options.activate = (i) => { options.adjust(i, 1); };
    options.onOpen = () => refreshOptions();
  }

  function refreshOptions() {
    for (let i = 0; i < optRows.length; i++) {
      const rec = optRows[i];
      const t = rec.text();
      if (rec.v.textContent !== t) rec.v.textContent = t;
      if (rec.meterFill && rec.meterValue) {
        rec.meterFill.style.transform = 'scaleX(' + clamp(rec.meterValue(), 0, 1).toFixed(3) + ')';
      }
    }
  }

  // ======================================================================
  // CREDITS
  // ======================================================================

  const credits = makeScreen('credits');
  credits.el.appendChild(el('div', 'scr-scrim hard'));
  credits.back = 'title';
  {
    const panel = el('div', 'scr-panel');
    const head = el('div', 'scr-head');
    head.appendChild(el('h2', null, 'CREDITS'));
    head.appendChild(el('div', 'sub', BRAND.line1 + ' ' + BRAND.line2));
    panel.appendChild(head);
    const body = el('div', 'scr-body');
    for (let i = 0; i < CREDITS.length; i++) {
      const sec = el('div', 'scr-cred-sec');
      sec.appendChild(el('h4', null, CREDITS[i][0]));
      const lines = CREDITS[i][1];
      for (let k = 0; k < lines.length; k++) sec.appendChild(el('p', null, lines[k]));
      body.appendChild(sec);
    }
    body.appendChild(el('div', 'scr-cred-note',
      'Rider names, teams and event branding in this build are invented. '
      + 'Any resemblance to a real rider, brand or competition is coincidental.'));
    panel.appendChild(body);
    const foot = el('div', 'scr-foot');
    foot.appendChild(hintRow([['ESC', 'BACK']]));
    panel.appendChild(foot);
    credits.el.appendChild(panel);
    credits.activate = () => goBack();
  }

  // ======================================================================
  // PAUSE
  // ======================================================================

  const pause = makeScreen('pause');
  {
    const panel = el('div', 'scr-panel');
    panel.style.maxWidth = 'calc(var(--su)*34)';
    const head = el('div', 'scr-head');
    head.appendChild(el('h2', null, 'PAUSED'));
    const psub = el('div', 'sub', '');
    head.appendChild(psub);
    panel.appendChild(head);
    const body = el('div', 'scr-body');
    const menu = el('nav', 'scr-menu');
    menu.style.background = 'none';
    menu.style.border = '0';
    menu.style.padding = '0';
    menu.style.boxShadow = 'none';
    menu.style.backdropFilter = 'none';
    for (let i = 0; i < MENU_PAUSE.length; i++) menu.appendChild(menuButton(pause, MENU_PAUSE[i], i));
    body.appendChild(menu);
    panel.appendChild(body);
    const foot = el('div', 'scr-foot');
    foot.appendChild(hintRow([['ESC', 'RESUME'], ['ENTER', 'SELECT']]));
    panel.appendChild(foot);
    pause.el.appendChild(panel);

    pause.onOpen = () => {
      const sc = ctx.player?.scoring;
      psub.textContent = sc
        ? (sc.timeText || '2:00') + ' LEFT — ' + fmt(sc.score || 0) + ' PTS'
        : 'CITY LOT';
      pause.sel = 0;
    };
    pause.activate = (i) => {
      const id = MENU_PAUSE[i].id;
      if (id === 'resume') resume();
      else if (id === 'restart') startSession();
      else if (id === 'options') openSub('options');
      else if (id === 'quit') quitToTitle();
    };
    pause.back = null;   // Escape resumes, handled explicitly
  }

  // ======================================================================
  // RESULTS
  // ======================================================================

  const results = makeScreen('results');
  results.el.appendChild(el('div', 'scr-scrim hard'));
  const tallyRows = [];
  let resGrade = null;
  let resNewHigh = null;
  let resSub = null;
  let resStrip = null;
  let resT = 0;
  let resDone = false;
  {
    const panel = el('div', 'scr-panel scr-res');
    const top = el('div', 'scr-res-top');
    const titleBox = el('div', 'scr-res-title');
    titleBox.appendChild(el('h2', null, 'SESSION COMPLETE'));
    resSub = el('div', 'sub', 'CITY LOT — 2:00');
    titleBox.appendChild(resSub);
    top.appendChild(titleBox);
    resGrade = el('div', 'scr-grade');
    resGrade.appendChild(el('div', 'l', '—'));
    resGrade.appendChild(el('div', 'w', ''));
    top.appendChild(resGrade);
    panel.appendChild(top);

    resNewHigh = el('div', 'scr-newhigh', 'NEW PERSONAL BEST');
    panel.appendChild(resNewHigh);

    const tally = el('div', 'scr-tally');
    const addTally = (label, unit, dec, final) => {
      const row = el('div', 'scr-tally-row' + (final ? ' final' : ''));
      row.appendChild(el('span', 'l', label));
      const v = el('span', 'v');
      const num = el('span', 'n', '0');
      const uni = el('span', 'u', unit || '');
      v.appendChild(num);
      v.appendChild(uni);
      row.appendChild(v);
      tally.appendChild(row);
      tallyRows.push({ row, num, uni, dec: dec || 0, value: 0, shown: -1 });
    };
    addTally('BEST COMBO', 'PTS', 0, false);
    addTally('LONGEST GRIND', 'S', 1, false);
    addTally('BIGGEST AIR', 'M', 1, false);
    addTally('TRICKS LANDED', '', 0, false);
    addTally('CHALLENGES', '', 0, false);
    addTally('FINAL SCORE', '', 0, true);
    panel.appendChild(tally);

    resStrip = el('div', 'scr-strip');
    panel.appendChild(resStrip);

    const btns = el('div', 'scr-res-btns');
    const mkBtn = (label, fn) => {
      const b = el('button', 'scr-btn', label);
      b.type = 'button';
      const index = results.items.length;
      b.addEventListener('click', () => { select(results, index); doActivate(); });
      b.addEventListener('pointerenter', () => select(results, index));
      results.items.push(b);
      btns.appendChild(b);
      return fn;
    };
    const actions = [];
    actions.push(mkBtn('RETRY RUN', startSession));
    actions.push(mkBtn('QUIT TO TITLE', quitToTitle));
    panel.appendChild(btns);
    results.el.appendChild(panel);

    results.activate = (i) => {
      if (!resDone) { resT = 99; return; }   // first press fast-forwards the tally
      actions[i]?.();
    };
  }

  function fillResults(res) {
    const r = res || {};
    const vals = [
      r.bestCombo || 0,
      r.longestGrind || 0,
      r.biggestAir || 0,
      r.tricksLanded || 0,
      r.goalsCompleted || 0,
      r.score || 0,
    ];
    for (let i = 0; i < tallyRows.length; i++) {
      tallyRows[i].value = vals[i] || 0;
      tallyRows[i].shown = -1;
      tallyRows[i].num.textContent = tallyRows[i].dec ? '0.0' : '0';
      tallyRows[i].row.classList.remove('in');
    }
    tallyRows[4].uni.textContent = '/ ' + (r.goalsTotal || 9);

    const g = gradeFor(r.score || 0);
    resGrade.className = 'scr-grade ' + g.cls;
    resGrade.firstChild.textContent = g.letter;
    resGrade.lastChild.textContent = g.word;

    resNewHigh.classList.toggle('on', !!r.newHighScore);

    const rank = r.rank || 6;
    const ord = rank === 1 ? '1ST' : rank === 2 ? '2ND' : rank === 3 ? '3RD' : rank + 'TH';
    resSub.textContent = 'CITY LOT — FINISHED ' + ord + ' OF '
      + ((r.leaderboard && r.leaderboard.length) || 6);

    while (resStrip.firstChild) resStrip.removeChild(resStrip.firstChild);
    const strip = [
      ['GAPS', String(r.gaps || 0)],
      ['LETTERS', (r.letters || 0) + ' / 3'],
      ['SMASHED', String(r.smashes || 0)],
      ['BAILS', String(r.bails || 0)],
      ['TRICK LIST', ((r.trickList && r.trickList.landed) || 0) + ' / '
        + ((r.trickList && r.trickList.total) || 46)],
    ];
    for (let i = 0; i < strip.length; i++) {
      const s = el('span', null, strip[i][0] + ' ');
      s.appendChild(el('b', null, strip[i][1]));
      resStrip.appendChild(s);
    }

    resT = 0;
    resDone = false;
    results.sel = 0;
  }

  function tickResults(dt) {
    if (resDone) return;
    resT += dt;
    let allIn = true;
    for (let i = 0; i < tallyRows.length; i++) {
      const rec = tallyRows[i];
      const start = 0.30 + i * 0.34;
      const p = clamp((resT - start) / 0.62, 0, 1);
      if (p <= 0) { allIn = false; continue; }
      if (!rec.row.classList.contains('in')) rec.row.classList.add('in');
      const v = rec.value * easeOut(p);
      const shown = rec.dec ? Math.round(v * 10) : Math.round(v);
      if (shown !== rec.shown) {
        rec.shown = shown;
        rec.num.textContent = rec.dec ? (shown / 10).toFixed(1) : fmt(shown);
      }
      if (p < 1) allIn = false;
    }
    const gradeAt = 0.30 + tallyRows.length * 0.34 + 0.35;
    if (resT >= gradeAt && !resGrade.classList.contains('in')) {
      resGrade.classList.add('in');
      sfx('rankUp');
    }
    if (allIn && resT >= gradeAt + 0.2) {
      resDone = true;
      for (let i = 0; i < tallyRows.length; i++) {
        const rec = tallyRows[i];
        rec.num.textContent = rec.dec ? rec.value.toFixed(1) : fmt(rec.value);
      }
      applySelection(results);
    }
  }

  // ======================================================================
  // GOAL BRIEFING
  // ======================================================================

  const brief = makeScreen('brief', 'scr-brief no-hit');
  let briefList = null;
  let briefTimer = 0;
  let briefShown = false;
  {
    const card = el('div', 'scr-brief-card');
    const head = el('div', 'scr-brief-head');
    head.appendChild(el('h2', null, 'SESSION GOALS'));
    head.appendChild(el('div', 'sub', 'CITY LOT — 2:00'));
    card.appendChild(head);
    briefList = el('div', 'scr-brief-list');
    card.appendChild(briefList);
    card.appendChild(el('div', 'scr-brief-foot',
      'Land tricks to start the clock. Bail and the combo — and the special meter — go with it.'));
    brief.el.appendChild(card);
  }

  function showBrief() {
    const sc = ctx.player?.scoring;
    const goals = sc?.goals || [];
    while (briefList.firstChild) briefList.removeChild(briefList.firstChild);
    if (!goals.length) {
      briefList.appendChild(el('div', 'scr-brief-goal', 'Score as much as you can in 2:00.'));
    } else {
      for (let i = 0; i < goals.length; i++) {
        const g = goals[i];
        const row = el('div', 'scr-brief-goal' + (g.everDone ? ' done' : ''));
        row.appendChild(el('i'));
        row.appendChild(el('span', null, g.text));
        briefList.appendChild(row);
      }
    }
    brief.el.classList.remove('is-on');
    void brief.el.offsetWidth;
    brief.el.classList.add('is-on');
    briefTimer = 3.2;
    briefShown = true;
  }

  function hideBrief() {
    brief.el.classList.remove('is-on');
    briefTimer = 0;
  }

  // ======================================================================
  // Selection / navigation
  // ======================================================================

  let state = 'none';
  let dormant = false;

  const BLOCKING = { title: 1, tour: 1, controls: 1, options: 1, credits: 1, pause: 1, results: 1 };
  const MENU_CAM = { title: 1, controls: 1, options: 1, credits: 1 };

  /** UI cues, mapped onto the names audio.js actually understands. */
  const SFX_ALIAS = { uiBack: 'uiMove', uiOpen: 'uiSelect' };
  function sfx(name) {
    const a = ctx.audio;
    if (!a) return;
    const n = SFX_ALIAS[name] || name;
    if (typeof a[n] === 'function') a[n]();
    else if (typeof a.play === 'function') a.play(n);
  }

  function applySelection(rec) {
    if (!rec) return;
    for (let i = 0; i < rec.items.length; i++) {
      rec.items[i].classList.toggle('is-sel', i === rec.sel);
    }
    const node = rec.items[rec.sel];
    if (node && state === rec.id) {
      node.focus({ preventScroll: true });
      if (node.scrollIntoView) node.scrollIntoView({ block: 'nearest' });
    }
  }

  function select(rec, i) {
    if (!rec || !rec.items.length) return;
    const n = rec.items.length;
    const next = ((i % n) + n) % n;
    if (next === rec.sel) return;
    rec.sel = next;
    applySelection(rec);
    sfx('uiMove');
  }

  function current() { return screens[state] || null; }

  function navMove(dir) {
    const rec = current();
    if (!rec || !rec.items.length) return;
    select(rec, rec.sel + dir);
  }

  function doAdjust(dir) {
    const rec = current();
    if (!rec) return;
    if (rec.adjust) { rec.adjust(rec.sel, dir); sfx('uiMove'); }
  }

  function doActivate() {
    const rec = current();
    if (!rec) return;
    // Menu confirms are always inside a real user gesture: a good moment to let
    // the audio module out of the browser's autoplay jail.
    ctx.audio?.resume?.();
    if (rec.activate) { sfx('uiSelect'); rec.activate(rec.sel); }
  }

  function goBack() {
    const rec = current();
    if (!rec) return;
    if (state === 'pause') { sfx('uiBack'); resume(); return; }
    if (!rec.back) return;          // title and results have nowhere to go back to
    sfx('uiBack');
    setState(rec.back);
  }

  function openSub(id) {
    if (!screens[id]) return;
    screens[id].back = state;
    setState(id);
  }

  // ---------------------------------------------------------------- state

  function setState(next) {
    if (dormant) return;
    if (next === state) return;
    const prev = screens[state];
    if (prev) {
      prev.el.classList.remove('is-on');
      prev.onClose?.();
    }
    state = next;
    const rec = screens[state];
    if (rec) {
      rec.sel = 0;
      rec.onOpen?.();
      rec.el.classList.remove('is-on');
      void rec.el.offsetWidth;               // restart the entrance animations
      rec.el.classList.add('is-on');
      applySelection(rec);
    }
    const blocking = !!BLOCKING[state];
    // Keep the blur veil up for anything opened out of the pause menu, so the
    // frozen frame behind never snaps back into focus mid-navigation.
    veil.classList.toggle('is-on', state === 'pause' || (rec && rec.back === 'pause'));
    if (ctx.flags) ctx.flags.paused = blocking;
    ctx.hud?.setClean?.(blocking && state !== 'pause');
    if (!blocking) {
      if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
      ctx.cameraRig?.snap?.(ctx);
    }
    api.state = state;
  }

  // ---------------------------------------------------------------- flow

  function startSession() {
    const sc = ctx.player?.scoring;
    sc?.restart?.();
    setState('none');
    ctx.cameraRig?.snap?.(ctx);
    briefShown = false;
    showBrief();
  }

  function resume() {
    setState('none');
  }

  function quitToTitle() {
    ctx.player?.scoring?.restart?.();
    hideBrief();
    setState('title');
  }

  // ======================================================================
  // Camera paths
  // ======================================================================

  const ORBIT = { x: -4, y: 3.4, z: -6, r0: 44, r1: 54, h0: 13, h1: 21 };
  let orbitT = 2.0;
  let camFov = 46;

  function writeCam(px, py, pz, tx, ty, tz, fov) {
    const cam = ctx.engine?.camera || ctx.camera;
    if (!cam) return;
    cam.position.set(px, py, pz);
    cam.up.set(0, 1, 0);
    cam.lookAt(tx, ty, tz);
    if (Math.abs(cam.fov - fov) > 0.01) {
      cam.fov = fov;
      cam.updateProjectionMatrix();
    }
    ctx.engine?.setSpeedBlur?.(0);
  }

  function driveOrbit(dt) {
    orbitT += dt;
    const a = orbitT * 0.035 + 0.7;
    const r = lerp(ORBIT.r0, ORBIT.r1, 0.5 + 0.5 * Math.sin(orbitT * 0.052));
    const h = lerp(ORBIT.h0, ORBIT.h1, 0.5 + 0.5 * Math.sin(orbitT * 0.037 + 1.2));
    writeCam(
      ORBIT.x + Math.sin(a) * r, h, ORBIT.z + Math.cos(a) * r,
      ORBIT.x, ORBIT.y, ORBIT.z, camFov);
  }

  function driveTour(dt) {
    if (tourIndex < 0) tourGoto(0);
    const s = TOUR[tourIndex];
    tourT += dt;
    if (tourT >= s.dur) {
      if (tourIndex + 1 >= TOUR.length) { setState('title'); return; }
      tourGoto(tourIndex + 1);
      return;
    }
    const p = smoothstep(clamp(tourT / s.dur, 0, 1));
    writeCam(
      lerp(s.from[0], s.to[0], p), lerp(s.from[1], s.to[1], p), lerp(s.from[2], s.to[2], p),
      s.look[0], s.look[1], s.look[2], 42);
  }

  let resOrbitT = 0;
  function driveResultsOrbit(dt) {
    resOrbitT += dt;
    const st = ctx.player?.physics?.state;
    const px = st ? st.position.x : 0;
    const py = st ? st.position.y : 1;
    const pz = st ? st.position.z : 0;
    const a = resOrbitT * 0.22 + 1.1;
    const r = 7.4;
    writeCam(px + Math.sin(a) * r, py + 3.0, pz + Math.cos(a) * r, px, py + 0.9, pz, 44);
  }

  // ======================================================================
  // Input
  // ======================================================================

  function onKeyDown(e) {
    if (dormant) return;

    // Rebind capture takes every key, including the ones the game binds.
    if (bindingRow && state === 'controls') {
      e.preventDefault();
      e.stopPropagation();
      if (e.code === 'Escape') { cancelRebind(); sfx('uiBack'); return; }
      if (e.code === 'Tab') return;
      commitRebind(e.code);
      return;
    }

    if (!BLOCKING[state]) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;

    const c = e.code;
    let used = true;
    if (c === 'ArrowUp' || c === 'KeyW') navMove(-1);
    else if (c === 'ArrowDown' || c === 'KeyS') navMove(1);
    else if (c === 'ArrowLeft' || c === 'KeyA') doAdjust(-1);
    else if (c === 'ArrowRight' || c === 'KeyD') doAdjust(1);
    else if (c === 'Enter' || c === 'NumpadEnter' || c === 'Space') doActivate();
    else if (c === 'Escape' || c === 'Backspace') goBack();
    else if (c === 'Tab') used = false;
    else used = false;

    if (used) { e.preventDefault(); e.stopPropagation(); }
  }

  window.addEventListener('keydown', onKeyDown, { capture: true });

  // --- gamepad (menus only) --------------------------------------------------
  const padState = { up: false, down: false, left: false, right: false, ok: false, back: false };
  let padRepeat = 0;

  function pollPad(dt) {
    const gp = typeof navigator !== 'undefined' && navigator.getGamepads
      ? navigator.getGamepads() : null;
    let pad = null;
    if (gp) for (let i = 0; i < gp.length; i++) { if (gp[i] && gp[i].connected) { pad = gp[i]; break; } }
    if (!pad) {
      padState.up = padState.down = padState.left = padState.right = false;
      padState.ok = padState.back = false;
      return;
    }
    const ax = pad.axes[0] || 0;
    const ay = pad.axes[1] || 0;
    const btn = (i) => !!(pad.buttons[i] && pad.buttons[i].pressed);
    const up = btn(12) || ay < -0.55;
    const down = btn(13) || ay > 0.55;
    const left = btn(14) || ax < -0.55;
    const right = btn(15) || ax > 0.55;
    const ok = btn(0);
    const back = btn(1);

    const held = up || down || left || right;
    if (!held) padRepeat = 0;
    else padRepeat -= dt;
    const repeatFire = held && padRepeat <= 0;

    if (up && (!padState.up || repeatFire)) { navMove(-1); padRepeat = padState.up ? 0.16 : 0.34; }
    else if (down && (!padState.down || repeatFire)) { navMove(1); padRepeat = padState.down ? 0.16 : 0.34; }
    else if (left && (!padState.left || repeatFire)) { doAdjust(-1); padRepeat = padState.left ? 0.18 : 0.36; }
    else if (right && (!padState.right || repeatFire)) { doAdjust(1); padRepeat = padState.right ? 0.18 : 0.36; }

    if (ok && !padState.ok) doActivate();
    if (back && !padState.back) goBack();

    padState.up = up; padState.down = down; padState.left = left; padState.right = right;
    padState.ok = ok; padState.back = back;
  }

  // ======================================================================
  // Session events
  // ======================================================================

  function onSessionEnd(e) {
    if (dormant) return;
    hideBrief();
    fillResults(e?.detail || ctx.player?.scoring?.results);
    resOrbitT = 0;
    setState('results');
  }

  function onSessionStart() {
    if (dormant || briefShown) return;
    if (BLOCKING[state]) return;
    showBrief();
  }

  const handlers = [['sessionEnd', onSessionEnd], ['sessionStart', onSessionStart]];
  for (let i = 0; i < handlers.length; i++) ctx.on?.(handlers[i][0], handlers[i][1]);

  // ======================================================================
  // Harness dormancy
  // ======================================================================

  let rigUpdateRef = null;

  function goDormant() {
    if (dormant) return;
    dormant = true;
    // Deliberately does NOT touch ctx.flags.paused: the harness owns it now.
    for (const id of Object.keys(screens)) screens[id].el.classList.remove('is-on');
    veil.classList.remove('is-on');
    state = 'none';
    api.state = 'none';
    ctx.hud?.setClean?.(false);
    root.style.display = 'none';
    if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
  }

  function harnessTookOver(c) {
    if (c.flags?.freeze || c.flags?.freeCam) return true;
    if (c.input && c.input.harness) return true;
    const rig = c.cameraRig;
    if (rig) {
      if (rigUpdateRef === null) rigUpdateRef = rig.update;
      else if (rig.update !== rigUpdateRef) return true;
    }
    return false;
  }

  // ======================================================================
  // Frame update
  // ======================================================================

  let pauseLatch = false;

  function update(dt, c) {
    const cx = c || ctx;
    if (dormant) return;
    if (harnessTookOver(cx)) { goDormant(); return; }

    const step = dt > 0.1 ? 0.1 : dt;

    // --- pause / back edge from input.js (covers Escape + gamepad Start) ------
    const pausePressed = !!cx.input?.pressed?.('pause');
    if (pausePressed && !pauseLatch) {
      pauseLatch = true;
      if (state === 'none') { sfx('uiBack'); setState('pause'); }
      else if (state === 'pause') resume();
      else if (state === 'tour') { sfx('uiBack'); setState('title'); }
      else if (state === 'controls' || state === 'options' || state === 'credits') goBack();
    } else if (!pausePressed) {
      pauseLatch = false;
    }

    // --- goal briefing timer -------------------------------------------------
    if (briefTimer > 0) {
      briefTimer -= step;
      if (briefTimer <= 0) hideBrief();
    }

    if (state === 'none') return;

    pollPad(step);

    if (MENU_CAM[state]) driveOrbit(step);
    else if (state === 'tour') driveTour(step);
    else if (state === 'results') { driveResultsOrbit(step); tickResults(step); }
  }

  // ======================================================================
  // Public API
  // ======================================================================

  const api = {
    root,
    state: 'none',
    settings,

    /** show('title'|'tour'|'controls'|'options'|'credits'|'pause'|'results'|'brief') */
    show(id) {
      if (dormant) return;
      if (id === 'brief') { showBrief(); return; }
      if (!screens[id]) return;
      setState(id);
    },

    /** hide() closes everything; hide(id) only closes `id` if it is up. */
    hide(id) {
      if (dormant) return;
      if (id === 'brief') { hideBrief(); return; }
      if (!id || id === state) setState('none');
    },

    isBlocking() { return !!BLOCKING[state]; },
    update,
    fixedUpdate() {},

    /** Kick a fresh run from anywhere (used by the menu and the results screen). */
    startSession,
    quitToTitle,
    showBrief,

    dispose() {
      window.removeEventListener('keydown', onKeyDown, { capture: true });
      for (let i = 0; i < handlers.length; i++) {
        ctx.events?.removeEventListener?.(handlers[i][0], handlers[i][1]);
      }
      if (ctx.flags) ctx.flags.paused = false;
      ctx.hud?.setClean?.(false);
      root.remove();
      styleEl?.remove();
    },
  };

  // ------------------------------------------------------------------ boot

  refreshBinds();
  refreshOptions();

  const params = typeof location !== 'undefined' ? new URLSearchParams(location.search) : null;
  const skipMenu = !!(params && (params.has('nomenu') || params.has('freeze')));
  if (!skipMenu) setState('title');
  else if (ctx.flags) ctx.flags.paused = false;

  return api;
}

export default createScreens;
