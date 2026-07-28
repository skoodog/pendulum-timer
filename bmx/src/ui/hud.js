// MIRRA CITY — the in-game HUD.
//
// A DOM overlay built to the reference frame: score + special meter + live
// competition leaderboard top-left, run timer top-centre, trick list top-right,
// trick callout bottom-centre, balance meters, challenge tracker, big centred
// flashes and toasts.
//
// Rules this file plays by:
//   * Every element is created once, in createHUD(). update() only ever writes
//     `textContent` (on change) and `transform` / class names. No element is
//     created, measured or re-laid-out per frame.
//   * All motion is CSS transitions/keyframes plus a handful of Web Animations
//     fired on discrete events — transform and opacity only, GPU friendly.
//   * Everything it reads from siblings is optional-chained with a sane
//     fallback, so a half-built scoring/grind/trick module can never break boot.
//
// State it reads (real field names, verified against the modules):
//   ctx.player.scoring  score displayScore comboPoints comboMultiplier comboActive
//                       comboText comboTimer01 special01 specialReady timeText
//                       timeLeft timeTotal phase rank leaderboard boardView goals
//                       goalsDone goalsTotal letters lettersCollected smashed
//                       smashTotal gapsCleared landedCount totalCount
//   ctx.player.tricks   TRICKS/list total landedCount hasLanded(id) difficultyTag()
//   ctx.player.grind    active balance critical trickName railType
//   ctx.player.physics.state  mode airTime balance manualType speed
//   ctx events          scoreBank scoreLost scoreGap goalComplete achievement
//                       rankUp specialReady letterCollected objectSmashed
//                       countdown sessionStart sessionEnd bail respawn
//
// Keys owned here (not in input.js's bind table, so nothing collides):
//   T — toggle the trick list      G — collapse/expand the challenge tracker

import { clamp } from '../core/mathx.js';

// ---------------------------------------------------------------------------
// Static presentation data
// ---------------------------------------------------------------------------

/** Which key holds each trick modifier, for the trick-list recipes. */
const MOD_KEY = {
  trickA: 'J', trickB: 'K', trickC: 'L',
  grind: 'U', lip: 'U', manual: 'I',
  spin: 'Q/E', hop: 'SPACE', flatA: 'J', flatB: 'K',
};

/** Extra context a recipe needs to actually fire. */
const MOD_NOTE = {
  lip: 'coping', flatA: 'flat', flatB: 'flat', manual: 'hold', spin: 'hold',
};

const DIR_ARROW = {
  N: '', U: '↑', D: '↓', L: '←', R: '→',
  UL: '↖', UR: '↗', DL: '↙', DR: '↘',
};

const CATEGORY_ORDER = ['air', 'grind', 'lip', 'manual', 'flatland'];
const CATEGORY_NAME = {
  air: 'AIR & ROTATION', grind: 'GRINDS', lip: 'LIP TRICKS',
  manual: 'MANUALS', flatland: 'FLATLAND',
};

const FLASH_TIME = 1.35;      // s a centred flash stays up
const TOAST_TIME = 3.1;       // s a toast lives
const BAIL_EDGE_TIME = 0.95;  // s of red screen-edge pulse
const MAX_TOASTS = 4;

// ---------------------------------------------------------------------------
// Tiny DOM helpers (build time only)
// ---------------------------------------------------------------------------

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

/** 37850 -> "37,850". Locale-independent so the layout never surprises us. */
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

// ---------------------------------------------------------------------------

export function createHUD(ctx) {
  const mount = document.getElementById('ui-root') || document.body;

  const root = el('div', 'hud');
  root.setAttribute('aria-hidden', 'true');

  root.appendChild(el('div', 'hud-scrim top'));
  root.appendChild(el('div', 'hud-scrim bottom'));

  // ======================================================================
  // TOP LEFT — score / special / leaderboard / challenges
  // ======================================================================

  const tl = el('div', 'hud-tl');

  const scoreRow = el('div', 'score-row');
  const scoreLabel = el('span', 'score-label', 'SCORE:');
  const scoreValue = el('span', 'score-value');
  const scoreDigitsEl = el('span', 'score-digits');
  scoreValue.appendChild(scoreDigitsEl);
  scoreRow.append(scoreLabel, scoreValue);

  const special = el('div', 'special');
  const specialFill = el('i', 'special-fill');
  const specialShine = el('i', 'special-shine');
  const specialSegs = el('i', 'special-segs');
  const specialGlow = el('i', 'special-glow');
  const specialLabel = el('span', 'special-label', 'SPECIAL');
  special.append(specialFill, specialShine, specialSegs, specialLabel, specialGlow);

  const board = el('div', 'board');

  const goalsPanel = el('div', 'hud-goals');
  const glHead = el('div', 'gl-head');
  const glTitle = el('span', null, 'CHALLENGES');
  const glSpacer = el('span', 'spacer');
  const glCount = el('span', 'gl-count', '0/9');
  const glKey = el('span', 'chip', 'G');
  glHead.append(glTitle, glSpacer, glCount, glKey);
  const glList = el('div', 'gl-list');
  const glFoot = el('div', 'gl-foot');
  const glLetters = el('div', 'gl-letters');
  const glSmash = el('span', null, 'SMASH 0/6');
  const glGaps = el('span', null, 'GAPS 0');
  glFoot.append(glLetters, glSmash, glGaps);
  goalsPanel.append(glHead, glList, glFoot);

  tl.append(scoreRow, special, board, goalsPanel);
  root.appendChild(tl);

  // ======================================================================
  // TOP CENTRE — timer + air time
  // ======================================================================

  const tc = el('div', 'hud-tc');
  const timerEl = el('div', 'timer');
  const timerInner = el('span', 'timer-i', '2:00');
  timerEl.appendChild(timerInner);
  const airEl = el('div', 'airtime', 'AIR 0.00');
  tc.append(timerEl, airEl);
  root.appendChild(tc);

  // ======================================================================
  // TOP RIGHT — trick list header
  // ======================================================================

  const tr = el('div', 'hud-tr');
  const tlHead = el('div', 'tl-head');
  const tlTitle = el('span', 'cond', 'TRICK LIST');
  const tlChip = el('span', 'chip', 'T');
  tlHead.append(tlTitle, tlChip);
  const tlSub = el('div', 'tl-sub');
  const tlCount = el('span', 'tl-count', '0 / 0');
  const tlDiff = el('span', 'tl-diff', 'AM');
  tlSub.append(tlCount, tlDiff);
  tr.append(tlHead, tlSub);
  root.appendChild(tr);

  const trickPanel = el('div', 'tricklist');
  const tkHead = el('div', 'tk-head');
  tkHead.append(el('span', null, 'TRICK LIST'));
  const tkHeadCount = el('span', 'tk-h-count', '0 / 0');
  tkHead.appendChild(tkHeadCount);
  const tkScroll = el('div', 'tk-scroll');
  trickPanel.append(tkHead, tkScroll);
  root.appendChild(trickPanel);

  // ======================================================================
  // BOTTOM CENTRE — trick callout
  // ======================================================================

  const callout = el('div', 'callout');
  const coPoints = el('div', 'co-points');
  const coPointsVal = el('span', 'co-val', '0');
  const coX = el('span', 'co-x', ' X ');
  const coMult = el('span', 'co-mult', '1');
  coPoints.append(coPointsVal, coX, coMult);
  const coChain = el('div', 'co-chain', '');
  const coBar = el('div', 'co-bar');
  const coBarFill = el('i', null, '');
  coBar.appendChild(coBarFill);
  callout.append(coPoints, coChain, coBar);
  root.appendChild(callout);

  // ======================================================================
  // Balance meters
  // ======================================================================

  function makeBalance(cls, label, axis) {
    const wrap = el('div', 'bal ' + cls);
    const shake = el('div', 'bal-shake');
    const track = el('div', 'bal-track');
    track.append(el('i', 'bal-zone a'), el('i', 'bal-zone b'), el('i', 'bal-mid'));
    const nwrap = el('div', 'bal-nwrap');
    nwrap.appendChild(el('i', 'bal-needle'));
    track.appendChild(nwrap);
    shake.appendChild(track);
    const lab = el('div', 'bal-label', label);
    wrap.append(shake, lab);
    return { wrap, nwrap, label: lab, axis, on: false, crit: false, shake: false, pos: 0, text: label };
  }

  const balH = makeBalance('bal-h', 'BALANCE', 'x');
  const balV = makeBalance('bal-v', 'MANUAL', 'y');
  root.append(balH.wrap, balV.wrap);

  // ======================================================================
  // Flash / toasts / bail edge / hint
  // ======================================================================

  const flash = el('div', 'flash');
  const flashMain = el('div', 'flash-main', '');
  const flashSub = el('div', 'flash-sub', '');
  flash.append(flashMain, flashSub);
  root.appendChild(flash);

  const toasts = el('div', 'toasts');
  root.appendChild(toasts);

  const edge = el('div', 'bail-edge');
  root.appendChild(edge);

  const hint = el('div', 'hint');
  const hintParts = [
    ['SHIFT', 'PEDAL'], ['SPACE', 'HOP'], ['J K L', 'TRICKS'],
    ['U', 'GRIND'], ['I', 'MANUAL'], ['R', 'RESET'],
  ];
  for (let i = 0; i < hintParts.length; i++) {
    const grp = el('span', null);
    grp.appendChild(el('b', null, hintParts[i][0]));
    grp.appendChild(document.createTextNode(' ' + hintParts[i][1]));
    hint.appendChild(grp);
  }
  root.appendChild(hint);

  mount.appendChild(root);

  // ======================================================================
  // Score digit cells (odometer roll)
  // ======================================================================

  const digitCells = [];    // { node, ch }
  let scoreShown = -1;

  const ROLL_KF = [
    { transform: 'translateY(0.42em)', opacity: 0.05 },
    { transform: 'translateY(0)', opacity: 1 },
  ];
  const ROLL_OPT = { duration: 165, easing: 'cubic-bezier(.2,.9,.25,1)' };

  function setScore(value) {
    const s = fmt(value);
    while (digitCells.length < s.length) {
      const node = el('span', 'dg');
      scoreDigitsEl.appendChild(node);
      digitCells.push({ node, ch: '' });
    }
    while (digitCells.length > s.length) {
      const d = digitCells.pop();
      d.node.remove();
    }
    const rollLimit = s.length - 2;   // the two lowest places just tick over
    for (let i = 0; i < s.length; i++) {
      const d = digitCells[i];
      const ch = s[i];
      if (d.ch === ch) continue;
      d.ch = ch;
      d.node.textContent = ch;
      const sep = ch === ',';
      if (sep !== d.node.classList.contains('sep')) d.node.classList.toggle('sep', sep);
      if (!sep && i < rollLimit && d.node.animate) d.node.animate(ROLL_KF, ROLL_OPT);
    }
  }
  setScore(0);

  // ======================================================================
  // Leaderboard rows
  // ======================================================================

  const rowByEntry = new Map();   // board entry object -> row record
  const rowList = [];
  let boardCutRec = null;

  function buildBoard(entries) {
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      if (rowByEntry.has(e)) continue;
      const node = el('div', 'bd-row' + (e.isPlayer ? ' is-player' : ''));
      const rank = el('span', 'bd-rank', '');
      const bar = el('i', 'bd-bar');
      const name = el('span', 'bd-name', String(e.name || ''));
      const score = el('span', 'bd-score', '');
      node.append(rank, bar, name, score);
      board.appendChild(node);
      const rec = { entry: e, node, rank, name, score, lastRank: -1, lastScore: -1, slot: -1, nameText: String(e.name || '') };
      rowByEntry.set(e, rec);
      rowList.push(rec);
    }
  }

  const RANK_KF = [{ filter: 'brightness(2.8)' }, { filter: 'brightness(1)' }];
  const RANK_OPT = { duration: 460, easing: 'ease-out' };

  function updateBoard(sc) {
    const all = sc.leaderboard;
    const view = sc.boardView;
    if (!Array.isArray(all) || !Array.isArray(view)) return;
    if (rowList.length !== all.length) buildBoard(all);

    for (let i = 0; i < rowList.length; i++) rowList[i].pending = -1;
    for (let i = 0; i < view.length && i < 5; i++) {
      const rec = rowByEntry.get(view[i]);
      if (rec) rec.pending = i;
    }
    // Mark the row that sits under a rank skip (player pushed into the last slot).
    const tailRec = rowByEntry.get(view[4]);
    const cutRec = tailRec && (tailRec.entry.rank || 5) > 5 ? tailRec : null;
    if (cutRec !== boardCutRec) {
      if (boardCutRec) boardCutRec.node.classList.remove('is-cut');
      boardCutRec = cutRec;
      if (cutRec) cutRec.node.classList.add('is-cut');
    }
    for (let i = 0; i < rowList.length; i++) {
      const rec = rowList[i];
      const slot = rec.pending;
      if (slot !== rec.slot) {
        rec.slot = slot;
        if (slot < 0) {
          rec.node.style.opacity = '0';
        } else {
          rec.node.style.transform = 'translateY(' + slot * 100 + '%)';
          rec.node.style.opacity = '1';
        }
      }
      if (slot < 0) continue;
      const e = rec.entry;
      const r = e.rank || slot + 1;
      if (r !== rec.lastRank) { rec.lastRank = r; rec.rank.textContent = String(r); }
      const s = Math.round(e.score || 0);
      if (s !== rec.lastScore) { rec.lastScore = s; rec.score.textContent = fmt(s); }
      const nm = String(e.name || '');
      if (nm !== rec.nameText) { rec.nameText = nm; rec.name.textContent = nm; }
    }
  }

  // ======================================================================
  // Challenge tracker rows
  // ======================================================================

  const goalRows = [];
  let goalsBuilt = false;

  function buildGoals(goals) {
    for (let i = 0; i < goals.length; i++) {
      const g = goals[i];
      const node = el('div', 'goal');
      const tick = el('i', 'gl-tick');
      const text = el('span', 'gl-text', String(g.text || ''));
      const prog = el('span', 'gl-prog', '');
      node.append(tick, text, prog);
      glList.appendChild(node);
      goalRows.push({ goal: g, node, prog, lastProg: '', done: false });
    }
    goalsBuilt = true;
  }

  const LETTER_IDS = ['B', 'M', 'X'];
  const letterCells = [];
  function buildLetters(letters) {
    const ids = letters && letters.length ? letters : LETTER_IDS;
    for (let i = 0; i < ids.length; i++) {
      const id = typeof ids[i] === 'string' ? ids[i] : (ids[i].id || ids[i].char || '?');
      const node = el('span', null, String(id));
      glLetters.appendChild(node);
      letterCells.push({ node, on: false });
    }
  }

  function goalProgressText(g) {
    if (!g) return '';
    if (g.done) return 'DONE';
    if (g.kind === 'score') return fmt(g.progress || 0) + ' / ' + fmt(g.target || 0);
    if (g.kind === 'count') return (g.progress || 0) + ' / ' + (g.target || 0);
    return '';
  }

  const GOAL_KF = [
    { transform: 'translateX(0) scale(1)', filter: 'brightness(3.2)' },
    { transform: 'translateX(1.5%) scale(1.02)', filter: 'brightness(1.6)', offset: 0.3 },
    { transform: 'translateX(0) scale(1)', filter: 'brightness(1)' },
  ];

  function updateGoals(sc) {
    const goals = sc.goals;
    if (!Array.isArray(goals) || !goals.length) return;
    if (!goalsBuilt) buildGoals(goals);
    for (let i = 0; i < goalRows.length; i++) {
      const rec = goalRows[i];
      const g = rec.goal;
      const done = !!g.done;
      if (done !== rec.done) {
        rec.done = done;
        rec.node.classList.toggle('is-done', done);
        if (done && rec.node.animate) rec.node.animate(GOAL_KF, { duration: 620, easing: 'ease-out' });
      }
      const p = goalProgressText(g);
      if (p !== rec.lastProg) { rec.lastProg = p; rec.prog.textContent = p; }
    }
    const dn = sc.goalsDone || 0;
    const tt = sc.goalsTotal || goals.length;
    if (dn !== lastGoalsDone || tt !== lastGoalsTotal) {
      lastGoalsDone = dn; lastGoalsTotal = tt;
      glCount.textContent = dn + '/' + tt;
    }

    const letters = sc.letters;
    if (Array.isArray(letters)) {
      if (!letterCells.length) buildLetters(letters);
      for (let i = 0; i < letterCells.length && i < letters.length; i++) {
        const got = !!letters[i].got;
        if (got !== letterCells[i].on) {
          letterCells[i].on = got;
          letterCells[i].node.classList.toggle('on', got);
        }
      }
    } else if (!letterCells.length) {
      buildLetters(null);
    }

    const sm = (sc.smashed || 0) + '/' + (sc.smashTotal || 0);
    if (sm !== lastSmash) { lastSmash = sm; glSmash.textContent = 'SMASH ' + sm; }
    const gp = sc.gapsCleared || 0;
    if (gp !== lastGaps) { lastGaps = gp; glGaps.textContent = 'GAPS ' + gp; }
  }

  let lastGoalsDone = -1;
  let lastGoalsTotal = -1;
  let lastSmash = '';
  let lastGaps = -1;

  // ======================================================================
  // Trick list panel
  // ======================================================================

  const trickRows = [];
  let trickPanelBuilt = false;
  let trickPanelOpen = false;
  let trickRefresh = 0;

  function recipeText(t) {
    const key = MOD_KEY[t.mod] || '?';
    const arrow = DIR_ARROW[t.dir] || '';
    const note = MOD_NOTE[t.mod];
    let s = key;
    if (arrow) s += ' ' + arrow;
    if (note) s += ' · ' + note;
    return s;
  }

  function buildTrickPanel(list) {
    for (let c = 0; c < CATEGORY_ORDER.length; c++) {
      const cat = CATEGORY_ORDER[c];
      let header = null;
      for (let i = 0; i < list.length; i++) {
        const t = list[i];
        if ((t.category || 'air') !== cat) continue;
        if (!header) {
          header = el('div', 'tk-cat', CATEGORY_NAME[cat] || cat.toUpperCase());
          tkScroll.appendChild(header);
        }
        const node = el('div', 'tk-row');
        node.append(
          el('span', 'tk-name', String(t.name || t.id)),
          el('span', 'tk-keys', recipeText(t)),
          el('span', 'tk-pts', fmt(t.base || 0)),
        );
        tkScroll.appendChild(node);
        trickRows.push({ id: t.id, node, got: false });
      }
    }
    trickPanelBuilt = true;
  }

  function refreshTrickPanel() {
    const tricks = ctx.player?.tricks;
    if (!trickPanelBuilt) {
      const list = tricks?.list || tricks?.TRICKS;
      if (!Array.isArray(list) || !list.length) return;
      buildTrickPanel(list);
    }
    const has = typeof tricks?.hasLanded === 'function' ? tricks.hasLanded : null;
    const set = tricks?.landed;
    for (let i = 0; i < trickRows.length; i++) {
      const r = trickRows[i];
      let got = false;
      if (has) got = !!has(r.id);
      else if (set && typeof set.has === 'function') got = set.has(r.id);
      if (got !== r.got) { r.got = got; r.node.classList.toggle('got', got); }
    }
    tkHeadCount.textContent = tlCount.textContent;
  }

  function setTrickPanel(open) {
    if (open === trickPanelOpen) return;
    trickPanelOpen = open;
    trickPanel.classList.toggle('on', open);
    if (open) { refreshTrickPanel(); trickRefresh = 0; }
  }

  // ======================================================================
  // Centre flash queue
  // ======================================================================

  const flashQueue = [];
  let flashTimer = 0;

  const FLASH_KF = [
    { opacity: 0, transform: 'translate(-50%,-50%) scale(1.28)' },
    { opacity: 1, transform: 'translate(-50%,-50%) scale(1)', offset: 0.14 },
    { opacity: 1, transform: 'translate(-50%,-50%) scale(1)', offset: 0.72 },
    { opacity: 0, transform: 'translate(-50%,-58%) scale(0.97)' },
  ];

  function pushFlash(kind, main, sub) {
    // A busy line can raise several banners at once; keep the queue short so the
    // HUD never lags behind the run.
    while (flashQueue.length >= 3) flashQueue.shift();
    flashQueue.push({ kind, main, sub: sub || '' });
  }

  let flashKind = '';
  function startFlash(f) {
    if (f.kind !== flashKind) {
      if (flashKind) flash.classList.remove('k-' + flashKind);
      flashKind = f.kind;
      if (flashKind) flash.classList.add('k-' + flashKind);
    }
    flashMain.textContent = f.main;
    flashSub.textContent = f.sub;
    flashSub.style.display = f.sub ? '' : 'none';
    if (flash.animate) {
      flash.animate(FLASH_KF, { duration: FLASH_TIME * 1000, easing: 'cubic-bezier(.2,.9,.25,1)' });
    }
    flashTimer = FLASH_TIME;
  }

  // ======================================================================
  // Toasts
  // ======================================================================

  const liveToasts = [];

  function pushToast(kind, label, name) {
    const node = el('div', 'toast k-' + kind);
    const body = el('div', 't-body');
    body.append(el('span', 't-kind', label), el('span', 't-name', name));
    node.appendChild(body);
    toasts.appendChild(node);
    if (node.animate) {
      node.animate(
        [
          { opacity: 0, transform: 'translateX(-14%)' },
          { opacity: 1, transform: 'translateX(0)', offset: 0.12 },
          { opacity: 1, transform: 'translateX(0)', offset: 0.84 },
          { opacity: 0, transform: 'translateX(-6%)' },
        ],
        { duration: TOAST_TIME * 1000, easing: 'cubic-bezier(.2,.9,.25,1)' },
      );
    }
    liveToasts.push({ node, t: TOAST_TIME });
    while (liveToasts.length > MAX_TOASTS) {
      const old = liveToasts.shift();
      old.node.remove();
    }
  }

  // ======================================================================
  // Event wiring
  // ======================================================================

  let coMode = 'idle';        // 'idle' | 'live' | 'out'
  let coTimer = 0;
  let edgeTimer = 0;

  const SCORE_POP = [
    { transform: 'scale(1)' },
    { transform: 'scale(1.14)', offset: 0.22 },
    { transform: 'scale(1)' },
  ];

  function onBank(e) {
    const d = e?.detail || null;
    const gained = d ? (d.points || 0) : 0;
    const mult = d ? (d.multiplier || 1) : 1;
    coPointsVal.textContent = fmt(gained);
    coMult.textContent = String(mult);
    callout.classList.remove('on', 'is-lost');
    callout.classList.add('is-bank');
    coMode = 'out';
    coTimer = 0.6;
    if (scoreValue.animate) scoreValue.animate(SCORE_POP, { duration: 320, easing: 'ease-out' });
    if (gained >= 25000) pushFlash('gold', fmt(gained), 'COMBO BANKED');
  }

  function onLost(e) {
    const d = e?.detail || null;
    if (d && !d.points && !d.tricks) return;
    callout.classList.remove('on', 'is-bank');
    callout.classList.add('is-lost');
    coChain.textContent = 'COMBO LOST';
    coMode = 'out';
    coTimer = 0.52;
  }

  function onGap(e) {
    const d = e?.detail;
    if (!d) return;
    pushFlash('gold', String(d.name || 'GAP').toUpperCase(), '+' + fmt(d.points || 0));
  }

  function onGoal(e) {
    const d = e?.detail;
    if (!d) return;
    pushFlash('goal', 'CHALLENGE COMPLETE', String(d.text || ''));
    pushToast('goal', 'CHALLENGE', String(d.text || ''));
  }

  function onAchievement(e) {
    const d = e?.detail;
    if (!d) return;
    pushToast('ach', 'ACHIEVEMENT', String(d.name || ''));
    pushFlash('ach', 'ACHIEVEMENT', String(d.name || ''));
  }

  function onRankUp(e) {
    const d = e?.detail;
    if (!d) return;
    const rank = d.rank || 0;
    if (d.first) pushFlash('rank', 'FIRST PLACE', 'YOU TOOK THE LEAD');
    else if (d.name) pushFlash('rank', 'RANK ' + rank, 'PASSED ' + String(d.name).toUpperCase());
    const rec = rowList.find((r) => r.entry.isPlayer);
    if (rec && rec.node.animate) rec.node.animate(RANK_KF, RANK_OPT);
  }

  function onSpecial(e) {
    if (e?.detail?.ready) pushFlash('special', 'SPECIAL READY', 'SIGNATURE TRICKS ARMED');
  }

  function onLetter(e) {
    const d = e?.detail;
    pushToast('goal', 'LETTER', String(d?.id || '?') + '  —  ' + (d?.collected || 0) + ' / ' + (d?.total || 3));
  }

  function onSmash(e) {
    const d = e?.detail;
    pushToast('goal', 'SMASHED', (d?.index || 0) + ' / ' + (d?.total || 0));
  }

  function onBail() {
    pushFlash('bail', 'BAIL!', '');
    edgeTimer = BAIL_EDGE_TIME;
    edge.classList.add('on');   // the layer only exists while it is needed
    if (edge.animate) {
      edge.animate(
        [{ opacity: 0 }, { opacity: 0.95, offset: 0.1 }, { opacity: 0.5, offset: 0.4 }, { opacity: 0 }],
        { duration: BAIL_EDGE_TIME * 1000, easing: 'ease-out' },
      );
    }
  }

  function onCountdown(e) {
    const s = e?.detail?.seconds;
    if (s == null || !timerEl.animate) return;
    timerEl.animate(
      [{ transform: 'scale(1)' }, { transform: 'scale(1.16)', offset: 0.2 }, { transform: 'scale(1)' }],
      { duration: 340, easing: 'ease-out' },
    );
  }

  function onSessionStart() {
    hint.classList.add('fade');
  }

  function onSessionEnd(e) {
    const d = e?.detail;
    callout.classList.remove('on', 'is-bank', 'is-lost');
    coMode = 'idle';
    pushFlash('gold', 'TIME', d ? fmt(d.score || 0) + ' PTS' : '');
    hint.classList.remove('fade');
  }

  function onRespawn() {
    callout.classList.remove('on', 'is-bank', 'is-lost');
    coMode = 'idle';
    coTimer = 0;
  }

  const handlers = [
    ['scoreBank', onBank],
    ['scoreLost', onLost],
    ['scoreGap', onGap],
    ['goalComplete', onGoal],
    ['achievement', onAchievement],
    ['rankUp', onRankUp],
    ['specialReady', onSpecial],
    ['letterCollected', onLetter],
    ['objectSmashed', onSmash],
    ['bail', onBail],
    ['countdown', onCountdown],
    ['sessionStart', onSessionStart],
    ['sessionEnd', onSessionEnd],
    ['respawn', onRespawn],
  ];
  for (let i = 0; i < handlers.length; i++) ctx.on?.(handlers[i][0], handlers[i][1]);

  // --- keys (T / G) ---------------------------------------------------------

  function onKeyDown(e) {
    if (e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.code === 'KeyT') { setTrickPanel(!trickPanelOpen); }
    else if (e.code === 'KeyG') { goalsPanel.classList.toggle('is-collapsed'); }
    else if (e.code === 'Escape' && trickPanelOpen) { setTrickPanel(false); }
  }
  window.addEventListener('keydown', onKeyDown);

  function onHeadClick() { setTrickPanel(!trickPanelOpen); }
  tlHead.addEventListener('click', onHeadClick);

  // ======================================================================
  // Per-frame update — writes only textContent (on change), transform, classes
  // ======================================================================

  let hidden = false;
  let clean = false;
  let lastSpecial = -1;
  let lastReady = null;
  let lastFull = null;
  let lastTime = '';
  let lastTimeCls = '';
  let lastCount = '';
  let lastDiff = '';
  let lastChain = '';
  let lastPts = -1;
  let lastMult = -1;
  let lastBar = -1;
  let lastBarLow = null;
  let lastAirOn = false;
  let lastAirText = '';
  let previewOn = false;

  const CHAIN_KF = [
    { opacity: 0, transform: 'translateY(38%) scale(0.96)' },
    { opacity: 1, transform: 'translateY(0) scale(1)' },
  ];
  const MULT_KF = [
    { transform: 'scale(1)' },
    { transform: 'scale(1.45)', offset: 0.25 },
    { transform: 'scale(1)' },
  ];

  function setBalance(b, on, pos, crit, edgeShake, text) {
    if (on !== b.on) { b.on = on; b.wrap.classList.toggle('on', on); }
    if (!on) return;
    if (Math.abs(pos - b.pos) > 0.004) {
      b.pos = pos;
      // +balance is "looping out" on a manual, which reads as the needle rising.
      b.nwrap.style.transform = b.axis === 'x'
        ? 'translateX(' + (pos * 46).toFixed(2) + '%)'
        : 'translateY(' + (pos * -46).toFixed(2) + '%)';
    }
    if (crit !== b.crit) { b.crit = crit; b.wrap.classList.toggle('crit', crit); }
    if (edgeShake !== b.shake) { b.shake = edgeShake; b.wrap.classList.toggle('is-shake', edgeShake); }
    if (text !== b.text) { b.text = text; b.label.textContent = text; }
  }

  function update(dt, c) {
    const cx = c || ctx;
    const step = Math.min(dt || 0, 0.1);

    const wantHidden = !!(cx.flags?.hideHud) || !!(cx.flags?.freeCam) || clean;
    if (wantHidden !== hidden) {
      hidden = wantHidden;
      root.classList.toggle('is-hidden', hidden);
      if (hidden) setTrickPanel(false);
    }
    if (hidden) return;

    const sc = cx.player?.scoring;
    const tricks = cx.player?.tricks;
    const grind = cx.player?.grind;
    const st = cx.player?.physics?.state;

    // ---- score ------------------------------------------------------------
    if (sc) {
      const shown = Math.round(previewOn ? 37850 : (sc.displayScore ?? sc.score ?? 0));
      if (shown !== scoreShown) { scoreShown = shown; setScore(shown); }

      // ---- special --------------------------------------------------------
      const s01 = clamp(previewOn ? 0.78 : (sc.special01 ?? sc.special ?? 0), 0, 1);
      if (Math.abs(s01 - lastSpecial) > 0.0025) {
        lastSpecial = s01;
        specialFill.style.transform = 'scaleX(' + s01.toFixed(4) + ')';
      }
      const ready = !!sc.specialReady;
      if (ready !== lastReady) { lastReady = ready; special.classList.toggle('is-ready', ready); }
      const full = s01 > 0.995;
      if (full !== lastFull) { lastFull = full; special.classList.toggle('is-full', full); }

      // ---- leaderboard ----------------------------------------------------
      updateBoard(sc);

      // ---- timer ----------------------------------------------------------
      const tt = sc.timeText || '2:00';
      if (tt !== lastTime) { lastTime = tt; timerInner.textContent = tt; }
      const left = sc.timeLeft ?? 120;
      const cls = left <= 10 ? 'crit' : (left <= 30 ? 'warn' : '');
      if (cls !== lastTimeCls) {
        if (lastTimeCls) timerEl.classList.remove(lastTimeCls);
        lastTimeCls = cls;
        if (cls) timerEl.classList.add(cls);
      }

      // ---- trick counter --------------------------------------------------
      const landedN = tricks?.landedCount ?? sc.landedCount ?? 0;
      const totalN = tricks?.total ?? sc.totalCount ?? 0;
      const cnt = landedN + ' / ' + totalN;
      if (cnt !== lastCount) { lastCount = cnt; tlCount.textContent = cnt; }
      const diff = (typeof tricks?.difficultyTag === 'function' ? tricks.difficultyTag() : 'AM') || 'AM';
      if (diff !== lastDiff) { lastDiff = diff; tlDiff.textContent = diff; }

      // ---- challenges -----------------------------------------------------
      updateGoals(sc);

      // ---- trick callout --------------------------------------------------
      const active = previewOn ? true : !!sc.comboActive;
      if (active) {
        if (coMode !== 'live') {
          coMode = 'live';
          coTimer = 0;
          callout.classList.remove('is-bank', 'is-lost');
          callout.classList.add('on');
          lastChain = '';
          lastMult = -1;
        }
        const pts = previewOn ? 2350 : Math.round(sc.comboPoints || 0);
        if (pts !== lastPts) { lastPts = pts; coPointsVal.textContent = fmt(pts); }
        const mult = previewOn ? 2 : (sc.comboMultiplier || 1);
        if (mult !== lastMult) {
          if (lastMult >= 0 && coMult.animate) coMult.animate(MULT_KF, { duration: 260, easing: 'ease-out' });
          lastMult = mult;
          coMult.textContent = String(mult);
        }
        const chain = previewOn ? 'No Footed Can Can + Barspin'
          : (sc.comboText || tricks?.comboText || '');
        if (chain !== lastChain) {
          lastChain = chain;
          coChain.textContent = chain;
          if (coChain.animate) coChain.animate(CHAIN_KF, { duration: 190, easing: 'cubic-bezier(.16,1,.3,1)' });
        }
        const special01 = !!sc.specialReady;
        callout.classList.toggle('is-special', special01);

        const bar = clamp(previewOn ? 0.72 : (sc.comboTimer01 ?? 1), 0, 1);
        if (Math.abs(bar - lastBar) > 0.01) {
          lastBar = bar;
          coBarFill.style.transform = 'scaleX(' + bar.toFixed(3) + ')';
        }
        const low = bar < 0.34;
        if (low !== lastBarLow) { lastBarLow = low; coBar.classList.toggle('low', low); }
      } else if (coMode === 'out') {
        coTimer -= step;
        if (coTimer <= 0) {
          coMode = 'idle';
          callout.classList.remove('is-bank', 'is-lost', 'on');
        }
      } else if (coMode === 'live') {
        coMode = 'idle';
        callout.classList.remove('on');
      }
    }

    // ---- balance meters -----------------------------------------------------
    const gOn = !!grind?.active;
    const gBal = clamp(grind?.balance ?? 0, -1, 1);
    setBalance(balH, gOn, gBal, !!grind?.critical || Math.abs(gBal) > 0.6,
      Math.abs(gBal) > 0.82, (grind?.trickName || 'GRIND').toUpperCase());

    const mOn = st?.mode === 'manual';
    const mBal = clamp(st?.balance ?? 0, -1, 1);
    setBalance(balV, mOn, mBal, Math.abs(mBal) > 0.6, Math.abs(mBal) > 0.82,
      st?.manualType === 'nose' ? 'NOSE MANUAL' : 'MANUAL');

    // ---- air time -----------------------------------------------------------
    const airOn = st?.mode === 'air' && (st.airTime || 0) > 0.32;
    if (airOn !== lastAirOn) { lastAirOn = airOn; airEl.classList.toggle('on', airOn); }
    if (airOn) {
      const txt = 'AIR ' + (st.airTime || 0).toFixed(2);
      if (txt !== lastAirText) { lastAirText = txt; airEl.textContent = txt; }
    }

    // ---- flashes / toasts / edge -------------------------------------------
    if (flashTimer > 0) {
      flashTimer -= step;
    } else if (flashQueue.length) {
      startFlash(flashQueue.shift());
    }
    for (let i = liveToasts.length - 1; i >= 0; i--) {
      const t = liveToasts[i];
      t.t -= step;
      if (t.t <= 0) { t.node.remove(); liveToasts.splice(i, 1); }
    }
    if (edgeTimer > 0) {
      edgeTimer -= step;
      if (edgeTimer <= 0) edge.classList.remove('on');
    }

    // ---- trick list panel refresh (only while open) -------------------------
    if (trickPanelOpen) {
      trickRefresh -= step;
      if (trickRefresh <= 0) { trickRefresh = 0.35; refreshTrickPanel(); }
    }
  }

  // ======================================================================
  // Public API
  // ======================================================================

  const api = {
    root,
    element: root,
    update,

    /** main.js drives visuals from update(); this exists for contract symmetry. */
    fixedUpdate() {},

    /** Clean mode for beauty shots: hides the whole overlay. */
    setClean(v) { clean = !!v; },
    isClean() { return clean; },

    show() { clean = false; },
    hide() { clean = true; },

    toggleTrickList(v) { setTrickPanel(v == null ? !trickPanelOpen : !!v); },
    toggleGoals(v) {
      if (v == null) goalsPanel.classList.toggle('is-collapsed');
      else goalsPanel.classList.toggle('is-collapsed', !v);
    },

    /** Anyone can throw a centred flash / a toast at the HUD. */
    flash(main, sub, kind) { pushFlash(kind || 'gold', String(main || ''), sub ? String(sub) : ''); },
    toast(label, name, kind) { pushToast(kind || 'goal', String(label || ''), String(name || '')); },

    /**
     * Screenshot/preview mode: paints the HUD with the reference frame's sample
     * numbers so a paused beauty shot still reads as a live run. Never enabled
     * by gameplay — the harness or the console has to ask for it.
     */
    preview(on) {
      previewOn = on == null ? !previewOn : !!on;
      scoreShown = -1; lastSpecial = -1; lastPts = -1; lastMult = -1; lastChain = '';
      return previewOn;
    },

    dispose() {
      for (let i = 0; i < handlers.length; i++) {
        ctx.events?.removeEventListener?.(handlers[i][0], handlers[i][1]);
      }
      window.removeEventListener('keydown', onKeyDown);
      tlHead.removeEventListener('click', onHeadClick);
      for (let i = 0; i < liveToasts.length; i++) liveToasts[i].node.remove();
      liveToasts.length = 0;
      root.remove();
    },
  };

  // Seed the board/goals immediately so frame 0 is already a complete HUD.
  const sc0 = ctx.player?.scoring;
  if (sc0) {
    if (Array.isArray(sc0.leaderboard)) buildBoard(sc0.leaderboard);
    if (Array.isArray(sc0.goals) && sc0.goals.length) buildGoals(sc0.goals);
    if (Array.isArray(sc0.letters)) buildLetters(sc0.letters);
    updateBoard(sc0);
  }
  if (!letterCells.length) buildLetters(null);
  coBarFill.style.transform = 'scaleX(1)';
  specialFill.style.transform = 'scaleX(0)';

  return api;
}

export default createHUD;
