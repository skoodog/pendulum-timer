// MIRRA CITY — rider profile model (the data half of the Rider Creator).
//
// This module owns ONE thing: the description of a rider. It builds no meshes and
// imports nothing from three.js, so `src/ui/riderCreator.js`, `src/rider/bike.js`,
// `src/rider/riderAnim.js` and the physics/trick systems can all lean on it without
// dragging the renderer in.
//
// What is in here
// ---------------
//   DEFAULT_PROFILE   the canonical shape (exactly the one in ARCHITECTURE.md)
//   OPTIONS           the full catalogue: every selectable value of every field,
//                     keyed by group, each value carrying its own display label and
//                     (for anything that has to become a material) a material spec
//                     that maps onto `materials.js` colourways / tint()
//   CATEGORIES        the tab/group description the creator screen is generated
//                     from — nothing about the UI is hand-written per option
//   createCustomization(ctx)  profiles + localStorage persistence + apply + cheats
//
// Colour convention: every colour in a profile is a plain 24-bit number (0xRRGGBB),
// which is what `new THREE.Color(x)` and `materials.tint(name, x)` both take. Loaders
// also accept '#rrggbb' strings and the American spelling `color`, because older
// stored profiles used them.
//
// Determinism: `randomize()` runs on a private xorshift32 seeded from an explicit
// seed (or a per-profile counter). It deliberately does NOT touch `mathx.rng()` —
// the world generator shares that stream and a rider re-roll must never shift the
// park's texture noise.
//
// Every brand mark referenced from here is invented for this game. Nothing in the
// catalogue names, imitates or abbreviates a real trademark.

import { clamp, lerp } from '../core/mathx.js';

// ---------------------------------------------------------------------------
// storage
// ---------------------------------------------------------------------------

export const STORAGE_KEY = 'mirracity.riders.v1';
export const PROFILE_VERSION = 3;      // bumped whenever the shape below changes

// Shapes we know how to read: v1 was a single flat object, v2 an array of nested
// profiles, v3 the current { version, activeId, profiles[] } envelope.
const LEGACY_KEYS = ['mirracity.rider.v1', 'mirracity.riders.v2', 'concreterepublic.rider.v1'];

// ---------------------------------------------------------------------------
// small builders for the catalogue
// ---------------------------------------------------------------------------

/** A colour swatch. Its id IS the hex, so a profile stores exactly what it shows. */
const sw = (hex, label) => ({ id: hex, hex, label });
/** A named choice, with any extra metadata a consumer needs (material spec, etc). */
const op = (id, label, extra) => (extra ? { id, label, ...extra } : { id, label });

/** Material spec helper — `name` is a key in the materials library. */
const mat = (name, colour, roughness, envMapIntensity) => {
  const m = { name };
  if (colour !== undefined) m.colour = colour;
  if (roughness !== undefined) m.roughness = roughness;
  if (envMapIntensity !== undefined) m.envMapIntensity = envMapIntensity;
  return m;
};

/** Anodised bike paint: the eight library colourways, plus tinted extras. */
const anod = (colour, rough = 0.85, env = 1.15) => mat('anodised', colour, rough, env);

// ---------------------------------------------------------------------------
// palettes
// ---------------------------------------------------------------------------

// A believable skin spread: 18 tones walking fair -> deep with warm, neutral,
// olive and rose undertones represented rather than three token swatches.
const SKIN = [
  sw(0xf4dbc8, 'Ivory'),
  sw(0xeed0b8, 'Porcelain'),
  sw(0xe9c3a4, 'Fair'),
  sw(0xe7bba6, 'Fair Rose'),
  sw(0xe0b393, 'Peach'),
  sw(0xd8a983, 'Sand'),
  sw(0xcea57c, 'Light Olive'),
  sw(0xc9906f, 'Beige'),
  sw(0xbc7f5e, 'Honey'),
  sw(0xb08055, 'Golden'),
  sw(0xad7350, 'Olive'),
  sw(0x9e6544, 'Tan'),
  sw(0x8c5636, 'Caramel'),
  sw(0x7d4f37, 'Chestnut'),
  sw(0x7a492e, 'Bronze'),
  sw(0x653a25, 'Umber'),
  sw(0x53301f, 'Cocoa'),
  sw(0x3f2418, 'Espresso'),
];

const HAIR_COLOURS = [
  sw(0x14100e, 'Jet Black'),
  sw(0x241d1a, 'Soft Black'),
  sw(0x33231a, 'Dark Brown'),
  sw(0x4a3122, 'Brown'),
  sw(0x5c3a22, 'Chestnut'),
  sw(0x745232, 'Light Brown'),
  sw(0x8a7a63, 'Ash'),
  sw(0xa78a5c, 'Dark Blond'),
  sw(0xd0ad6a, 'Blond'),
  sw(0xe6dcc0, 'Platinum'),
  sw(0x9c4a1e, 'Ginger'),
  sw(0x6d2f1c, 'Auburn'),
  sw(0xb03225, 'Dyed Red'),
  sw(0x9b9a97, 'Grey'),
  sw(0xdedcd6, 'White'),
  sw(0x1f3f8c, 'Dyed Blue'),
  sw(0x1f6b3a, 'Dyed Green'),
  sw(0xc94a8a, 'Dyed Pink'),
  sw(0x5a2b8c, 'Dyed Purple'),
  sw(0xefe6cf, 'Bleached'),
];

// Broad garment palette — deliberately desaturated so it sits in the overcast grade.
const CLOTH = [
  sw(0x121316, 'Black'),
  sw(0x24262b, 'Charcoal'),
  sw(0x3c4048, 'Slate'),
  sw(0x5b616b, 'Ash Grey'),
  sw(0x8f959d, 'Light Grey'),
  sw(0xd8d6cf, 'Off White'),
  sw(0xf2efe6, 'White'),
  sw(0x1b2a4a, 'Navy'),
  sw(0x1d4f9c, 'Royal Blue'),
  sw(0x2f7fb5, 'Sky'),
  sw(0x1a8c86, 'Teal'),
  sw(0x1f6b3a, 'Forest'),
  sw(0x5e8c2a, 'Moss'),
  sw(0xb9a12b, 'Mustard'),
  sw(0xd07a1c, 'Amber'),
  sw(0xc4531d, 'Burnt Orange'),
  sw(0x9e1f22, 'Deep Red'),
  sw(0xd23b45, 'Signal Red'),
  sw(0x8d2f5e, 'Plum'),
  sw(0x5a2b8c, 'Purple'),
  sw(0x6b5a44, 'Khaki'),
  sw(0x3a2b22, 'Coffee'),
];

const ACCENT = [
  sw(0xf2efe6, 'White'),
  sw(0x121316, 'Black'),
  sw(0xd8d6cf, 'Bone'),
  sw(0xb9a12b, 'Gold'),
  sw(0xd07a1c, 'Amber'),
  sw(0xd23b45, 'Red'),
  sw(0x1d4f9c, 'Blue'),
  sw(0x1a8c86, 'Teal'),
  sw(0x5e8c2a, 'Lime'),
  sw(0xc94a8a, 'Pink'),
  sw(0x5a2b8c, 'Purple'),
  sw(0x8f959d, 'Grey'),
];

const DENIM = [
  sw(0x2b3a52, 'Indigo'),
  sw(0x3f5573, 'Mid Wash'),
  sw(0x5c7492, 'Light Wash'),
  sw(0x7d92a8, 'Stone Wash'),
  sw(0x1a1c22, 'Raw Black'),
  sw(0x2a2c31, 'Washed Black'),
  sw(0x4a4437, 'Sand'),
  sw(0x6b5a44, 'Khaki'),
  sw(0x39422c, 'Army'),
  sw(0x8f959d, 'Grey'),
  sw(0x3a2b22, 'Brown'),
  sw(0xd8d6cf, 'Off White'),
];

const SHOE_COLOURS = [
  sw(0x121316, 'Black'),
  sw(0x24262b, 'Charcoal'),
  sw(0xf2efe6, 'White'),
  sw(0xd8d6cf, 'Bone'),
  sw(0x8f959d, 'Grey'),
  sw(0x1b2a4a, 'Navy'),
  sw(0x9e1f22, 'Red'),
  sw(0x1f6b3a, 'Green'),
  sw(0x6b5a44, 'Gum Tan'),
  sw(0x3a2b22, 'Brown'),
  sw(0xb9a12b, 'Gold'),
  sw(0xc4531d, 'Orange'),
];

const LACES = [
  sw(0xf2efe6, 'White'),
  sw(0x121316, 'Black'),
  sw(0xd8d6cf, 'Bone'),
  sw(0xd23b45, 'Red'),
  sw(0x1d4f9c, 'Blue'),
  sw(0x5e8c2a, 'Lime'),
  sw(0xb9a12b, 'Gold'),
  sw(0xc94a8a, 'Pink'),
];

const GRIP_COLOURS = [
  sw(0x141518, 'Black'),
  sw(0x2f3238, 'Graphite'),
  sw(0x6b5a44, 'Gum'),
  sw(0x9e1f22, 'Red'),
  sw(0x1d4f9c, 'Blue'),
  sw(0x1a8c86, 'Teal'),
  sw(0x5e8c2a, 'Lime'),
  sw(0xb9a12b, 'Gold'),
  sw(0xc94a8a, 'Pink'),
  sw(0xd8d6cf, 'White'),
  sw(0x5a2b8c, 'Purple'),
  sw(0xc4531d, 'Orange'),
];

// ---------------------------------------------------------------------------
// invented brand marks for printed graphics — no real trademarks anywhere
// ---------------------------------------------------------------------------

const GRAPHICS = [
  op('none', 'Plain', { mark: 'none' }),
  op('boltCrest', 'Bolt Crest', { mark: 'emblem', text: 'CONCRETE REPUBLIC' }),
  op('wingedSprocket', 'Winged Sprocket', { mark: 'emblem', text: 'PENDULUM WORKS' }),
  op('stackedType', 'Stacked Type', { mark: 'wordmark', text: 'IRON LOT' }),
  op('scriptTag', 'Script Tag', { mark: 'script', text: 'Flatside' }),
  op('chevronRun', 'Chevron Run', { mark: 'geo' }),
  op('orbitGrid', 'Orbit Grid', { mark: 'geo', text: 'NIGHT OWL' }),
  op('doubleDiamond', 'Double Diamond', { mark: 'geo' }),
  op('raceStripes', 'Race Stripes', { mark: 'stripe' }),
  op('sleeveBands', 'Sleeve Bands', { mark: 'stripe' }),
  op('raceNumber', 'Race Number', { mark: 'number', text: '13' }),
  op('pegLife', 'Peg Life', { mark: 'script', text: 'Peg Life' }),
  op('emberFlame', 'Ember Flame', { mark: 'emblem' }),
  op('concreteWave', 'Concrete Wave', { mark: 'geo', text: 'CITY LOT' }),
  op('fiveStar', 'Five Star', { mark: 'emblem', text: 'GRIT & CO' }),
  op('circleLockup', 'Circle Lockup', { mark: 'wordmark', text: 'SIX PACK BMX' }),
];

const DECAL_SETS = [
  op('none', 'Clean', { mark: 'none' }),
  op('downtubeScript', 'Downtube Script', { mark: 'script', text: 'Pendulum' }),
  op('blockLogo', 'Block Logo', { mark: 'wordmark', text: 'IRON LOT' }),
  op('pinstripe', 'Pinstripe', { mark: 'stripe' }),
  op('fadeSplit', 'Fade Split', { mark: 'fade' }),
  op('camoPanel', 'Camo Panel', { mark: 'panel' }),
  op('checkerBand', 'Checker Band', { mark: 'stripe' }),
  op('starPanel', 'Star Panel', { mark: 'panel' }),
  op('sponsorStack', 'Sponsor Stack', { mark: 'wordmark', text: 'GRIT & CO' }),
  op('numberPlate', 'Number Plate', { mark: 'number', text: '13' }),
];

// ---------------------------------------------------------------------------
// bike part catalogues — every entry resolves to a materials.js colourway
// ---------------------------------------------------------------------------

// The eight library colourways (materials.bikePaint.*) come first so the common
// case is a zero-cost lookup; the rest are tint()s of `anodised`.
const FRAMES = [
  op('chrome', 'Polished Chrome', { mat: mat('bike_chrome') }),
  op('raw', 'Raw Alloy', { mat: mat('bike_raw') }),
  op('black', 'Flat Black', { mat: mat('bike_black') }),
  op('red', 'Blood Red', { mat: mat('bike_red') }),
  op('blue', 'Electric Blue', { mat: mat('bike_blue') }),
  op('purple', 'Anodised Purple', { mat: mat('bike_purple') }),
  op('gold', 'Brushed Gold', { mat: mat('bike_gold') }),
  op('teal', 'Deep Teal', { mat: mat('bike_teal') }),
  op('white', 'Gloss White', { mat: anod(0xe6e7ea, 0.55, 1.2) }),
  op('army', 'Army Green', { mat: anod(0x3c4a2c) }),
  op('orange', 'Safety Orange', { mat: anod(0xc4531d, 0.8) }),
  op('lime', 'Acid Lime', { mat: anod(0x7fa829, 0.8) }),
  op('copper', 'Burnt Copper', { mat: anod(0x8a4a24, 0.7, 1.25) }),
  op('midnight', 'Midnight Blue', { mat: anod(0x172038) }),
  op('rose', 'Dusty Rose', { mat: anod(0xa8586a) }),
  op('gunmetal', 'Gunmetal', { mat: anod(0x50555c, 0.9, 1.1) }),
];

const RIMS = [
  op('black', 'Black', { mat: mat('bike_black') }),
  op('chrome', 'Chrome', { mat: mat('bike_chrome') }),
  op('raw', 'Raw Polished', { mat: mat('bike_raw') }),
  op('red', 'Red', { mat: mat('bike_red') }),
  op('blue', 'Blue', { mat: mat('bike_blue') }),
  op('gold', 'Gold', { mat: mat('bike_gold') }),
  op('teal', 'Teal', { mat: mat('bike_teal') }),
  op('purple', 'Purple', { mat: mat('bike_purple') }),
  op('white', 'White', { mat: anod(0xe6e7ea, 0.6, 1.2) }),
  op('lime', 'Lime', { mat: anod(0x7fa829, 0.8) }),
];

const TYRES = [
  op('black', 'Black Wall', { mat: mat('rubber', 0x1a1b1e), wall: 0x1a1b1e, tread: 'knobby' }),
  op('gum', 'Gum Wall', { mat: mat('rubber', 0x1a1b1e), wall: 0x9c6a34, tread: 'knobby' }),
  op('tan', 'Tan Wall', { mat: mat('rubber', 0x1a1b1e), wall: 0xb4885a, tread: 'street' }),
  op('white', 'White Wall', { mat: mat('rubber', 0x1a1b1e), wall: 0xd8d6cf, tread: 'street' }),
  op('slick', 'Street Slick', { mat: mat('rubber', 0x141517, 0.86), wall: 0x141517, tread: 'slick' }),
  op('grey', 'Grey Compound', { mat: mat('rubber', 0x4a4d52), wall: 0x4a4d52, tread: 'knobby' }),
  op('red', 'Red Wall', { mat: mat('rubber', 0x1a1b1e), wall: 0x8f2a26, tread: 'street' }),
  op('blue', 'Blue Wall', { mat: mat('rubber', 0x1a1b1e), wall: 0x27407a, tread: 'street' }),
];

const SEATS = [
  op('black', 'Black Pivotal', { mat: mat('cloth', 0x141518, 0.78) }),
  op('grey', 'Grey Fade', { mat: mat('cloth', 0x555a62, 0.8) }),
  op('red', 'Red Stitch', { mat: mat('cloth', 0x8f2a26, 0.8) }),
  op('blue', 'Blue Stitch', { mat: mat('cloth', 0x27407a, 0.8) }),
  op('tan', 'Tan Leather', { mat: mat('plasticGloss', 0x8a6236, 0.55) }),
  op('white', 'White Vinyl', { mat: mat('plasticGloss', 0xd8d6cf, 0.42) }),
  op('camo', 'Camo Print', { mat: mat('cloth', 0x4a5238, 0.85), print: 'camo' }),
  op('teal', 'Teal Suede', { mat: mat('cloth', 0x1a6b68, 0.9) }),
];

const PEGS = [
  op('none', 'No Pegs', { mat: null, count: 0 }),
  op('chrome', 'Chrome (4)', { mat: mat('bike_chrome'), count: 4 }),
  op('black', 'Black (4)', { mat: mat('bike_black'), count: 4 }),
  op('raw', 'Raw Steel (4)', { mat: mat('bike_raw'), count: 4 }),
  op('rearOnly', 'Chrome Rear (2)', { mat: mat('bike_chrome'), count: 2 }),
  op('blackRear', 'Black Rear (2)', { mat: mat('bike_black'), count: 2 }),
  op('gold', 'Gold (4)', { mat: mat('bike_gold'), count: 4 }),
  op('red', 'Red (4)', { mat: mat('bike_red'), count: 4 }),
  op('teal', 'Teal (4)', { mat: mat('bike_teal'), count: 4 }),
];

// "chrome" in the profile means the finish of every hardware part: cranks, stem,
// bars, hubs, spokes, headset, sprocket.
const HARDWARE = [
  op('chrome', 'Chrome Hardware', { mat: mat('bike_chrome') }),
  op('black', 'Black Hardware', { mat: mat('bike_black') }),
  op('raw', 'Raw Hardware', { mat: mat('bike_raw') }),
  op('gold', 'Gold Hardware', { mat: mat('bike_gold') }),
  op('gunmetal', 'Gunmetal Hardware', { mat: anod(0x50555c, 0.9, 1.15) }),
  op('mixed', 'Black + Chrome', { mat: mat('bike_black'), secondary: mat('bike_chrome') }),
];

// ---------------------------------------------------------------------------
// wearable style catalogues
// ---------------------------------------------------------------------------

const HAIR_STYLES = [
  op('short', 'Short Crop', { volume: 0.35, long: 0 }),
  op('buzz', 'Buzz Cut', { volume: 0.12, long: 0 }),
  op('bald', 'Shaved', { volume: 0, long: 0 }),
  op('fade', 'High Fade', { volume: 0.4, long: 0 }),
  op('messy', 'Messy', { volume: 0.55, long: 0.1 }),
  op('spikes', 'Spiked', { volume: 0.6, long: 0 }),
  op('curly', 'Curly', { volume: 0.7, long: 0.15 }),
  op('afro', 'Afro', { volume: 0.95, long: 0.1 }),
  op('mohawk', 'Mohawk', { volume: 0.8, long: 0 }),
  op('longStraight', 'Long Straight', { volume: 0.5, long: 0.8 }),
  op('shag', 'Shag', { volume: 0.6, long: 0.45 }),
  op('ponytail', 'Ponytail', { volume: 0.45, long: 0.6 }),
  op('bun', 'Top Knot', { volume: 0.4, long: 0.25 }),
  op('braids', 'Braids', { volume: 0.5, long: 0.7 }),
  op('dreads', 'Dreads', { volume: 0.7, long: 0.75 }),
  op('bowl', 'Bowl Cut', { volume: 0.45, long: 0.05 }),
];

const FACIAL_HAIR = [
  op('none', 'Clean Shaven', { coverage: 0 }),
  op('stubble', 'Stubble', { coverage: 0.2 }),
  op('soulPatch', 'Soul Patch', { coverage: 0.1 }),
  op('moustache', 'Moustache', { coverage: 0.15 }),
  op('goatee', 'Goatee', { coverage: 0.3 }),
  op('chinstrap', 'Chinstrap', { coverage: 0.35 }),
  op('shortBeard', 'Short Beard', { coverage: 0.6 }),
  op('fullBeard', 'Full Beard', { coverage: 0.9 }),
  op('muttonChops', 'Mutton Chops', { coverage: 0.5 }),
  op('horseshoe', 'Horseshoe', { coverage: 0.4 }),
];

const HEADWEAR = [
  op('none', 'Bare Head', { covers: 0 }),
  op('helmet', 'Skate Helmet', { covers: 1, pad: true }),
  op('cap', 'Cap', { covers: 0.6 }),
  op('capBackwards', 'Cap Backwards', { covers: 0.6 }),
  op('beanie', 'Beanie', { covers: 0.9 }),
];

const TOPS = [
  op('tee', 'Tee', { sleeve: 0.45, loose: 0.5 }),
  op('raglan', 'Raglan', { sleeve: 0.72, loose: 0.45, twoTone: true }),
  op('jersey', 'Race Jersey', { sleeve: 0.95, loose: 0.3, twoTone: true }),
  op('hoodie', 'Hoodie', { sleeve: 1, loose: 0.75, hood: true }),
  op('tank', 'Tank', { sleeve: 0, loose: 0.4 }),
];

const BOTTOMS = [
  op('jeans', 'Jeans', { length: 1, loose: 0.6 }),
  op('shorts', 'Shorts', { length: 0.45, loose: 0.55 }),
  op('pants', 'Work Pants', { length: 1, loose: 0.45 }),
  op('joggers', 'Joggers', { length: 0.95, loose: 0.35, cuffed: true }),
];

const SHOES = [
  op('skate', 'Skate Shoe', { bulk: 0.7, high: 0 }),
  op('vulc', 'Vulcanised', { bulk: 0.45, high: 0 }),
  op('hightop', 'High Top', { bulk: 0.75, high: 1 }),
  op('runner', 'Runner', { bulk: 0.5, high: 0 }),
  op('boot', 'Work Boot', { bulk: 0.9, high: 0.6 }),
];

const GENDERS = [
  op('male', 'Male'),
  op('female', 'Female'),
  op('neutral', 'Neutral'),
];

const ON_OFF = [op(false, 'Off'), op(true, 'On')];

// ---------------------------------------------------------------------------
// DEFAULT_PROFILE — the canonical shape. Everything else is validated against it.
// ---------------------------------------------------------------------------

export const DEFAULT_PROFILE = {
  id: 'rider_default',
  version: PROFILE_VERSION,
  name: 'Rookie',
  gender: 'male',
  height: 1.78,
  build: 0.45,
  skin: 0xd8a983,
  hair: { style: 'short', colour: 0x33231a },
  facialHair: { style: 'none', colour: 0x33231a },
  headwear: 'capBackwards',
  headwearColour: 0x121316,
  top: { style: 'tee', colour: 0x24262b, accent: 0xf2efe6, graphic: 'boltCrest' },
  bottom: { style: 'jeans', colour: 0x2b3a52 },
  shoes: { style: 'skate', colour: 0x121316, laces: 0xf2efe6 },
  gloves: { on: false, colour: 0x121316 },
  pads: { knee: false, elbow: false, shin: false },
  bike: {
    frame: 'black',
    rims: 'black',
    tyres: 'gum',
    grips: 0x141518,
    seat: 'black',
    pegs: 'chrome',
    chrome: 'chrome',
    decals: 'downtubeScript',
  },
};

// ---------------------------------------------------------------------------
// group table — the single source of truth for the UI, for normalisation and for
// randomisation. Adding an option means adding it here and nowhere else.
// ---------------------------------------------------------------------------

/**
 * kind:
 *   'choice' — pick one of `values` (ids may be strings or booleans)
 *   'swatch' — pick one of `values`, whose ids are 24-bit colours
 *   'slider' — a number in [min, max] stepped by `step`
 */
const GROUPS = [
  // --- body ---------------------------------------------------------------
  { key: 'gender', label: 'Body Type', kind: 'choice', path: 'gender', values: GENDERS,
    category: 'body', hint: 'Drives skeleton proportions and body shape.' },
  { key: 'height', label: 'Height', kind: 'slider', path: 'height',
    min: 1.60, max: 1.95, step: 0.01, unit: 'm', decimals: 2, category: 'body',
    hint: 'Rebuilds the rig and the fit on the bike.' },
  { key: 'build', label: 'Build', kind: 'slider', path: 'build',
    min: 0, max: 1, step: 0.01, decimals: 2, category: 'body',
    labels: ['Slim', 'Heavy'], hint: 'Limb girth, torso depth, shoulder width.' },
  { key: 'skin', label: 'Skin Tone', kind: 'swatch', path: 'skin', values: SKIN, category: 'body' },

  // --- face ---------------------------------------------------------------
  { key: 'hairStyle', label: 'Hair', kind: 'choice', path: 'hair.style', values: HAIR_STYLES, category: 'face' },
  { key: 'hairColour', label: 'Hair Colour', kind: 'swatch', path: 'hair.colour', values: HAIR_COLOURS, category: 'face' },
  { key: 'facialHairStyle', label: 'Facial Hair', kind: 'choice', path: 'facialHair.style', values: FACIAL_HAIR, category: 'face' },
  { key: 'facialHairColour', label: 'Facial Hair Colour', kind: 'swatch', path: 'facialHair.colour', values: HAIR_COLOURS, category: 'face' },
  { key: 'headwear', label: 'Headwear', kind: 'choice', path: 'headwear', values: HEADWEAR, category: 'face' },
  { key: 'headwearColour', label: 'Headwear Colour', kind: 'swatch', path: 'headwearColour', values: CLOTH, category: 'face' },

  // --- outfit -------------------------------------------------------------
  { key: 'topStyle', label: 'Top', kind: 'choice', path: 'top.style', values: TOPS, category: 'outfit' },
  { key: 'topColour', label: 'Top Colour', kind: 'swatch', path: 'top.colour', values: CLOTH, category: 'outfit' },
  { key: 'topAccent', label: 'Top Accent', kind: 'swatch', path: 'top.accent', values: ACCENT, category: 'outfit' },
  { key: 'topGraphic', label: 'Chest Graphic', kind: 'choice', path: 'top.graphic', values: GRAPHICS, category: 'outfit' },
  { key: 'bottomStyle', label: 'Bottoms', kind: 'choice', path: 'bottom.style', values: BOTTOMS, category: 'outfit' },
  { key: 'bottomColour', label: 'Bottoms Colour', kind: 'swatch', path: 'bottom.colour', values: DENIM, category: 'outfit' },
  { key: 'shoeStyle', label: 'Shoes', kind: 'choice', path: 'shoes.style', values: SHOES, category: 'outfit' },
  { key: 'shoeColour', label: 'Shoe Colour', kind: 'swatch', path: 'shoes.colour', values: SHOE_COLOURS, category: 'outfit' },
  { key: 'laceColour', label: 'Laces', kind: 'swatch', path: 'shoes.laces', values: LACES, category: 'outfit' },
  { key: 'glovesOn', label: 'Gloves', kind: 'choice', path: 'gloves.on', values: ON_OFF, category: 'outfit' },
  { key: 'gloveColour', label: 'Glove Colour', kind: 'swatch', path: 'gloves.colour', values: CLOTH, category: 'outfit' },
  { key: 'padKnee', label: 'Knee Pads', kind: 'choice', path: 'pads.knee', values: ON_OFF, category: 'outfit' },
  { key: 'padElbow', label: 'Elbow Pads', kind: 'choice', path: 'pads.elbow', values: ON_OFF, category: 'outfit' },
  { key: 'padShin', label: 'Shin Guards', kind: 'choice', path: 'pads.shin', values: ON_OFF, category: 'outfit' },

  // --- bike ---------------------------------------------------------------
  { key: 'bikeFrame', label: 'Frame', kind: 'choice', path: 'bike.frame', values: FRAMES, category: 'bike' },
  { key: 'bikeRims', label: 'Rims', kind: 'choice', path: 'bike.rims', values: RIMS, category: 'bike' },
  { key: 'bikeTyres', label: 'Tyres', kind: 'choice', path: 'bike.tyres', values: TYRES, category: 'bike' },
  { key: 'bikeGrips', label: 'Grips', kind: 'swatch', path: 'bike.grips', values: GRIP_COLOURS, category: 'bike' },
  { key: 'bikeSeat', label: 'Seat', kind: 'choice', path: 'bike.seat', values: SEATS, category: 'bike' },
  { key: 'bikePegs', label: 'Pegs', kind: 'choice', path: 'bike.pegs', values: PEGS, category: 'bike' },
  { key: 'bikeChrome', label: 'Hardware', kind: 'choice', path: 'bike.chrome', values: HARDWARE, category: 'bike' },
  { key: 'bikeDecals', label: 'Decals', kind: 'choice', path: 'bike.decals', values: DECAL_SETS, category: 'bike' },
];

const CATEGORY_META = [
  { id: 'body', label: 'Body', hint: 'Frame size and shape' },
  { id: 'face', label: 'Face', hint: 'Head, hair and lid' },
  { id: 'outfit', label: 'Outfit', hint: 'Kit, colours and pads' },
  { id: 'bike', label: 'Bike', hint: 'Build the ride' },
];

// ---------------------------------------------------------------------------
// path helpers
// ---------------------------------------------------------------------------

export function getAt(obj, path) {
  if (!obj || !path) return undefined;
  let cur = obj;
  for (const part of String(path).split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = cur[part];
  }
  return cur;
}

export function setAt(obj, path, value) {
  if (!obj || !path) return obj;
  const parts = String(path).split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const k = parts[i];
    if (!cur[k] || typeof cur[k] !== 'object') cur[k] = {};
    cur = cur[k];
  }
  cur[parts[parts.length - 1]] = value;
  return obj;
}

// default per group, read straight off DEFAULT_PROFILE so there is one source
for (const g of GROUPS) g.default = getAt(DEFAULT_PROFILE, g.path);

const GROUP_BY_KEY = new Map(GROUPS.map((g) => [g.key, g]));
const GROUP_BY_PATH = new Map(GROUPS.map((g) => [g.path, g]));

/** Tabs for the creator screen; every control is generated from this. */
export const CATEGORIES = CATEGORY_META.map((c) => ({
  ...c,
  groups: GROUPS.filter((g) => g.category === c.id),
}));

/** The whole catalogue, keyed by group key. */
export const OPTIONS = (() => {
  const out = {};
  for (const g of GROUPS) {
    out[g.key] = g.kind === 'slider'
      ? { key: g.key, label: g.label, kind: g.kind, path: g.path, min: g.min, max: g.max, step: g.step, default: g.default, unit: g.unit, labels: g.labels }
      : { key: g.key, label: g.label, kind: g.kind, path: g.path, values: g.values, default: g.default };
  }
  return out;
})();

/** Flat list of every group (label, key, kind, values) — the data the UI walks. */
export const OPTION_GROUPS = GROUPS;

export function groupFor(keyOrPath) {
  return GROUP_BY_KEY.get(keyOrPath) || GROUP_BY_PATH.get(keyOrPath) || null;
}

/** All selectable values of a group (empty for sliders). */
export function valuesFor(keyOrPath) {
  const g = groupFor(keyOrPath);
  return g && g.values ? g.values : [];
}

/** The full option record for one id — carries `mat`, `text`, `bulk`, etc. */
export function optionFor(keyOrPath, id) {
  const g = groupFor(keyOrPath);
  if (!g || !g.values) return null;
  return g.values.find((v) => v.id === id) || null;
}

// ---------------------------------------------------------------------------
// colour + label utilities
// ---------------------------------------------------------------------------

const HEX_RE = /^#?([0-9a-f]{6})$/i;
const SHORT_HEX_RE = /^#?([0-9a-f]{3})$/i;

/** Accepts 0xRRGGBB, '#rrggbb', 'rrggbb', '#rgb'. Returns a number or null. */
export function toColour(v) {
  if (typeof v === 'number' && Number.isFinite(v)) {
    const n = Math.round(v);
    return n >= 0 && n <= 0xffffff ? n : null;
  }
  if (typeof v === 'string') {
    const s = v.trim();
    let m = HEX_RE.exec(s);
    if (m) return parseInt(m[1], 16);
    m = SHORT_HEX_RE.exec(s);
    if (m) {
      const [r, g, b] = m[1];
      return parseInt(r + r + g + g + b + b, 16);
    }
    if (/^0x[0-9a-f]{1,6}$/i.test(s)) return parseInt(s.slice(2), 16);
  }
  return null;
}

/** '#rrggbb' for CSS. */
export function hexString(colour) {
  const n = toColour(colour) ?? 0;
  return '#' + n.toString(16).padStart(6, '0');
}

function titleCase(s) {
  return String(s)
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Display name for anything the creator needs to print.
 *   prettyName('bikeFrame', 'black')  -> 'Flat Black'
 *   prettyName('skin', 0xd8a983)      -> 'Sand'
 *   prettyName(profile)               -> the rider's name
 *   prettyName('capBackwards')        -> 'Cap Backwards'
 */
export function prettyName(a, b) {
  if (b !== undefined) {
    const g = groupFor(a);
    if (g) {
      if (g.kind === 'slider') {
        const n = Number(b);
        if (Number.isFinite(n)) {
          const d = g.decimals ?? 2;
          return n.toFixed(d) + (g.unit ? ' ' + g.unit : '');
        }
      }
      const v = g.values && g.values.find((o) => o.id === b);
      if (v) return v.label;
    }
    return prettyName(b);
  }
  if (a === null || a === undefined) return '';
  if (typeof a === 'boolean') return a ? 'On' : 'Off';
  if (typeof a === 'object') {
    if (typeof a.label === 'string') return a.label;
    if (typeof a.name === 'string') return a.name;
    return '';
  }
  if (typeof a === 'number') {
    // a colour if it looks like one, otherwise a plain number
    if (Number.isInteger(a) && a >= 0 && a <= 0xffffff) {
      for (const g of GROUPS) {
        if (g.kind !== 'swatch') continue;
        const v = g.values.find((o) => o.id === a);
        if (v) return v.label;
      }
      return hexString(a).toUpperCase();
    }
    return String(a);
  }
  const s = String(a);
  for (const g of GROUPS) {
    if (!g.values) continue;
    const v = g.values.find((o) => o.id === s);
    if (v) return v.label;
  }
  return titleCase(s);
}

// ---------------------------------------------------------------------------
// normalisation + migration
// ---------------------------------------------------------------------------

const MAX_NAME = 18;

export function sanitizeName(name) {
  let s = typeof name === 'string' ? name : '';
  // strip control characters, collapse whitespace — the name is drawn in the HUD
  s = s.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (s.length > MAX_NAME) s = s.slice(0, MAX_NAME).trim();
  return s || DEFAULT_PROFILE.name;
}

let idCounter = 0;
function newId() {
  idCounter++;
  const t = (Date.now() % 0xfffffff).toString(36);
  return `rider_${t}_${idCounter.toString(36)}`;
}

/** Normalised copy of `base` under a brand new id, stamped as just created. */
function freshProfile(base) {
  const src = { ...(base && typeof base === 'object' ? base : {}) };
  delete src.id;
  delete src.created;
  delete src.updated;
  const p = normalizeProfile(src, { id: newId() });
  p.created = Date.now();
  p.updated = p.created;
  return p;
}

/** Deep copy of a plain JSON-ish value. */
function clone(v) {
  if (Array.isArray(v)) return v.map(clone);
  if (v && typeof v === 'object') {
    const out = {};
    for (const k of Object.keys(v)) out[k] = clone(v[k]);
    return out;
  }
  return v;
}

/** Recursively accept the American spelling stored by older builds. */
function unifySpelling(v) {
  if (Array.isArray(v)) return v.map(unifySpelling);
  if (!v || typeof v !== 'object') return v;
  const out = {};
  for (const k of Object.keys(v)) {
    const key = k === 'color' ? 'colour' : k === 'colors' ? 'colours' : k;
    if (key in out && k !== key) continue;    // an explicit `colour` wins
    out[key] = unifySpelling(v[k]);
  }
  return out;
}

/**
 * Pull a v1/v2 flat profile up to the nested shape. Unknown keys are ignored, so a
 * profile written by a newer build degrades instead of exploding.
 */
function fromLegacy(input) {
  const p = unifySpelling(input && typeof input === 'object' ? input : {});
  const out = clone(p);

  // v1 stored the outfit as flat keys
  if (p.shirtColour !== undefined || p.shirtStyle !== undefined || p.graphic !== undefined) {
    out.top = { ...(out.top || {}) };
    if (p.shirtStyle !== undefined && out.top.style === undefined) out.top.style = p.shirtStyle;
    if (p.shirtColour !== undefined && out.top.colour === undefined) out.top.colour = p.shirtColour;
    if (p.accentColour !== undefined && out.top.accent === undefined) out.top.accent = p.accentColour;
    if (p.graphic !== undefined && out.top.graphic === undefined) out.top.graphic = p.graphic;
  }
  if (p.pantsColour !== undefined || p.pantsStyle !== undefined) {
    out.bottom = { ...(out.bottom || {}) };
    if (p.pantsStyle !== undefined && out.bottom.style === undefined) out.bottom.style = p.pantsStyle;
    if (p.pantsColour !== undefined && out.bottom.colour === undefined) out.bottom.colour = p.pantsColour;
  }
  if (p.hairStyle !== undefined || p.hairColour !== undefined) {
    out.hair = { ...(out.hair || {}) };
    if (p.hairStyle !== undefined && out.hair.style === undefined) out.hair.style = p.hairStyle;
    if (p.hairColour !== undefined && out.hair.colour === undefined) out.hair.colour = p.hairColour;
  }
  if (p.beard !== undefined || p.beardStyle !== undefined) {
    out.facialHair = { ...(out.facialHair || {}) };
    const st = p.beardStyle !== undefined ? p.beardStyle : (p.beard === true ? 'fullBeard' : p.beard);
    if (st !== undefined && out.facialHair.style === undefined) out.facialHair.style = st;
  }
  if (p.shoeColour !== undefined || p.shoeStyle !== undefined) {
    out.shoes = { ...(out.shoes || {}) };
    if (p.shoeStyle !== undefined && out.shoes.style === undefined) out.shoes.style = p.shoeStyle;
    if (p.shoeColour !== undefined && out.shoes.colour === undefined) out.shoes.colour = p.shoeColour;
  }
  if (typeof p.gloves === 'boolean') out.gloves = { on: p.gloves, colour: p.gloveColour };
  if (typeof p.pads === 'boolean') out.pads = { knee: p.pads, elbow: p.pads, shin: p.pads };
  if (p.helmet === true && out.headwear === undefined) out.headwear = 'helmet';
  if (p.hat !== undefined && out.headwear === undefined) out.headwear = p.hat;

  // v1/v2 bike: a single colour, or a flat set of colour keys
  const bike = { ...(out.bike && typeof out.bike === 'object' ? out.bike : {}) };
  if (p.bikeColour !== undefined && bike.frame === undefined) bike.frame = p.bikeColour;
  if (p.frameColour !== undefined && bike.frame === undefined) bike.frame = p.frameColour;
  if (p.rimColour !== undefined && bike.rims === undefined) bike.rims = p.rimColour;
  if (p.tyreStyle !== undefined && bike.tyres === undefined) bike.tyres = p.tyreStyle;
  if (p.gripColour !== undefined && bike.grips === undefined) bike.grips = p.gripColour;
  if (Object.keys(bike).length) out.bike = bike;

  // skin used to be an index into a short swatch list; no real skin colour is a
  // number that small, so an integer under the palette length can only be an index
  if (typeof p.skinTone === 'number' && out.skin === undefined) {
    out.skin = SKIN[clamp(Math.round(p.skinTone), 0, SKIN.length - 1)].id;
  }
  if (typeof out.skin === 'number' && Number.isInteger(out.skin) && out.skin >= 0 && out.skin < SKIN.length) {
    out.skin = SKIN[out.skin].id;
  }
  return out;
}

function coerceChoice(group, value) {
  if (value === undefined || value === null) return group.default;
  // exact match first
  if (group.values.some((v) => v.id === value)) return value;
  if (typeof value === 'string') {
    const lower = value.trim().toLowerCase();
    const byId = group.values.find((v) => String(v.id).toLowerCase() === lower);
    if (byId) return byId.id;
    const byLabel = group.values.find((v) => v.label.toLowerCase() === lower);
    if (byLabel) return byLabel.id;
    if (lower === 'true' || lower === 'on' || lower === 'yes') {
      const t = group.values.find((v) => v.id === true);
      if (t) return true;
    }
    if (lower === 'false' || lower === 'off' || lower === 'no' || lower === 'none') {
      const f = group.values.find((v) => v.id === false);
      if (f) return false;
    }
  }
  if (typeof value === 'boolean') {
    const hit = group.values.find((v) => v.id === value);
    if (hit) return hit.id;
  }
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0 && value < group.values.length) {
    return group.values[value].id;                       // legacy index
  }
  return group.default;
}

function coerceSwatch(group, value) {
  const c = toColour(value);
  if (c !== null) return c;
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0 && value < group.values.length) {
    return group.values[value].id;                       // legacy palette index
  }
  if (typeof value === 'string') {
    const lower = value.trim().toLowerCase();
    const hit = group.values.find((v) => v.label.toLowerCase() === lower);
    if (hit) return hit.id;
  }
  return group.default;
}

function coerceSlider(group, value) {
  let n = typeof value === 'number' ? value : parseFloat(value);
  if (!Number.isFinite(n)) return group.default;
  n = clamp(n, group.min, group.max);
  const steps = Math.round((n - group.min) / group.step);
  n = group.min + steps * group.step;
  // kill float noise so 1.7800000000000002 never reaches the UI
  const dp = Math.max(0, Math.ceil(-Math.log10(group.step)) + 1);
  return clamp(parseFloat(n.toFixed(dp)), group.min, group.max);
}

/**
 * Coerce anything into a valid, complete profile. Never throws, never returns
 * null — an empty object comes back as a copy of the default rider.
 */
export function normalizeProfile(input, opts = {}) {
  const src = fromLegacy(input);
  const out = {
    id: typeof src.id === 'string' && src.id ? src.id : (opts.id || newId()),
    version: PROFILE_VERSION,
    name: sanitizeName(src.name),
  };
  for (const g of GROUPS) {
    const raw = getAt(src, g.path);
    let val;
    if (g.kind === 'slider') val = coerceSlider(g, raw);
    else if (g.kind === 'swatch') val = coerceSwatch(g, raw);
    else val = coerceChoice(g, raw);
    setAt(out, g.path, val);
  }
  // keep the creation stamp if there is one; it orders the profile list
  out.created = Number.isFinite(src.created) ? src.created : Date.now();
  out.updated = Number.isFinite(src.updated) ? src.updated : out.created;
  return out;
}

/**
 * Report on a profile without mutating it.
 * -> { ok, errors[], warnings[], profile }  (profile is the normalised copy)
 */
export function validate(profile) {
  const errors = [];
  const warnings = [];
  if (!profile || typeof profile !== 'object') {
    errors.push('profile is not an object');
    return { ok: false, errors, warnings, profile: normalizeProfile({}) };
  }
  const src = fromLegacy(profile);
  const rawName = typeof src.name === 'string' ? src.name : '';
  if (!rawName.trim()) warnings.push('name is empty — defaulted');
  else if (rawName.trim().length > MAX_NAME) warnings.push(`name longer than ${MAX_NAME} characters — truncated`);

  for (const g of GROUPS) {
    const raw = getAt(src, g.path);
    if (raw === undefined || raw === null) { warnings.push(`${g.path} missing — defaulted`); continue; }
    if (g.kind === 'slider') {
      const n = typeof raw === 'number' ? raw : parseFloat(raw);
      if (!Number.isFinite(n)) errors.push(`${g.path} is not a number`);
      else if (n < g.min || n > g.max) warnings.push(`${g.path} out of range — clamped`);
    } else if (g.kind === 'swatch') {
      if (toColour(raw) === null) warnings.push(`${g.path} is not a colour — defaulted`);
    } else if (!g.values.some((v) => v.id === raw)) {
      warnings.push(`${g.path} "${raw}" is not a known option — defaulted`);
    }
  }
  return { ok: errors.length === 0, errors, warnings, profile: normalizeProfile(src) };
}

// ---------------------------------------------------------------------------
// derived data — what the mesh builder actually wants
// ---------------------------------------------------------------------------

const GENDER_SHAPE = {
  male:    { shoulder: 1.00, hip: 0.94, chest: 1.00, waist: 0.98, legRatio: 0.470, neck: 1.00, jaw: 1.00, brow: 1.00 },
  female:  { shoulder: 0.90, hip: 1.07, chest: 0.94, waist: 0.90, legRatio: 0.487, neck: 0.93, jaw: 0.90, brow: 0.92 },
  neutral: { shoulder: 0.95, hip: 1.00, chest: 0.97, waist: 0.94, legRatio: 0.478, neck: 0.96, jaw: 0.95, brow: 0.96 },
};

const BASE_HEIGHT = 1.78;      // the height bike.js authors its bind pose at

/**
 * Everything height/build/gender imply, in one object, so `bike.js` can rebuild the
 * rig and re-fit the rider on the bike from numbers rather than re-deriving them.
 * All scales are relative to the 1.78 m default rider.
 */
export function riderMetrics(profile) {
  const p = profile && profile.height !== undefined ? profile : DEFAULT_PROFILE;
  const height = clamp(Number(p.height) || BASE_HEIGHT, 1.60, 1.95);
  const build = clamp(Number(p.build) ?? 0.45, 0, 1);
  const shape = GENDER_SHAPE[p.gender] || GENDER_SHAPE.neutral;

  const heightScale = height / BASE_HEIGHT;
  // taller riders are proportionally leggier, shorter ones stockier
  const legBias = lerp(0.975, 1.03, (height - 1.60) / 0.35);
  const girth = lerp(0.86, 1.30, build);

  return {
    height,
    build,
    gender: p.gender || 'neutral',
    heightScale,
    legScale: heightScale * legBias * (shape.legRatio / GENDER_SHAPE.male.legRatio),
    torsoScale: heightScale * lerp(1.02, 0.985, (height - 1.60) / 0.35),
    armScale: heightScale * lerp(0.99, 1.02, (height - 1.60) / 0.35),
    neckScale: heightScale * shape.neck,
    headScale: lerp(1.03, 0.97, (height - 1.60) / 0.35),     // heads scale sub-linearly
    shoulderWidth: shape.shoulder * lerp(0.94, 1.16, build) * heightScale,
    hipWidth: shape.hip * lerp(0.95, 1.18, build) * heightScale,
    chestDepth: shape.chest * lerp(0.90, 1.32, build),
    waistDepth: shape.waist * lerp(0.86, 1.40, build),
    limbGirth: girth,
    forearmGirth: lerp(0.90, 1.20, build),
    calfGirth: lerp(0.90, 1.26, build),
    jaw: shape.jaw,
    brow: shape.brow,
    massKg: lerp(56, 98, build) * (0.55 + 0.45 * heightScale * heightScale),

    // --- fit on the bike (metres of offset from the default setup) ---------
    fit: {
      seatHeight: (height - BASE_HEIGHT) * 0.46,     // saddle raises with inseam
      barRise: (height - BASE_HEIGHT) * 0.13,        // taller riders sit up a touch
      reach: (height - BASE_HEIGHT) * 0.20,          // hands further up the bars
      pedalDrop: (height - BASE_HEIGHT) * 0.05,
      standWidth: lerp(0.0, 0.022, build),           // knees track wider on heavy builds
    },
  };
}

/**
 * Flatten a profile into material specs. Each `{ name, colour?, roughness?,
 * envMapIntensity? }` names a material in `materials.js` — pass it to
 * `materials.get(name)` when there is no colour, or `materials.tint(name, colour,
 * {...})` when there is.
 */
export function materialPlan(profile) {
  const p = normalizeProfile(profile);
  const pick = (key, id) => optionFor(key, id) || {};

  const frame = pick('bikeFrame', p.bike.frame);
  const rims = pick('bikeRims', p.bike.rims);
  const tyres = pick('bikeTyres', p.bike.tyres);
  const seat = pick('bikeSeat', p.bike.seat);
  const pegs = pick('bikePegs', p.bike.pegs);
  const hw = pick('bikeChrome', p.bike.chrome);
  const decals = pick('bikeDecals', p.bike.decals);
  const graphic = pick('topGraphic', p.top.graphic);

  return {
    rider: {
      skin: { name: 'skin', colour: p.skin },
      hair: { name: 'hair', colour: p.hair.colour, style: p.hair.style },
      facialHair: { name: 'hair', colour: p.facialHair.colour, style: p.facialHair.style },
      top: {
        ...mat('cloth', p.top.colour, 0.92),
        accent: p.top.accent,
        style: p.top.style,
        graphic: graphic.id || 'none',
        graphicMark: graphic.mark || 'none',
        graphicText: graphic.text || '',
      },
      bottom: { ...mat('cloth', p.bottom.colour, 0.95), style: p.bottom.style },
      shoes: { ...mat('cloth', p.shoes.colour, 0.85), laces: p.shoes.laces, style: p.shoes.style },
      gloves: p.gloves.on ? { ...mat('cloth', p.gloves.colour, 0.8), on: true } : { on: false },
      headwear: p.headwear === 'none'
        ? { style: 'none' }
        : { ...mat(p.headwear === 'helmet' ? 'plasticGloss' : 'cloth', p.headwearColour,
          p.headwear === 'helmet' ? 0.34 : 0.9), style: p.headwear },
      pads: { ...p.pads, ...mat('plasticGloss', 0x1a1c20, 0.55) },
    },
    bike: {
      frame: frame.mat || mat('bike_black'),
      rims: rims.mat || mat('bike_black'),
      tyres: tyres.mat || mat('rubber', 0x1a1b1e),
      tyreWall: tyres.wall ?? 0x1a1b1e,
      tread: tyres.tread || 'knobby',
      grips: mat('rubber', p.bike.grips, 0.86),
      seat: seat.mat || mat('cloth', 0x141518, 0.78),
      seatPrint: seat.print || 'none',
      pegs: pegs.mat || null,
      pegCount: pegs.count ?? 0,
      hardware: hw.mat || mat('bike_chrome'),
      hardwareSecondary: hw.secondary || null,
      decals: {
        id: decals.id || 'none',
        mark: decals.mark || 'none',
        text: decals.text || '',
        colour: p.top.accent,
      },
    },
  };
}

/** One-line summary for profile cards. */
export function describeProfile(profile) {
  const p = normalizeProfile(profile);
  const bits = [
    prettyName('gender', p.gender),
    `${p.height.toFixed(2)} m`,
    prettyName('topStyle', p.top.style),
    prettyName('bikeFrame', p.bike.frame),
  ];
  return bits.join(' · ');
}

// ---------------------------------------------------------------------------
// the easter egg
// ---------------------------------------------------------------------------

// Obfuscated only so the string does not fall out of a `strings dist/*.js` glance
// in one piece. Nothing about it is advertised in the UI and nothing logs.
const EGG = ['james', 'paterson'].join(' ');

export const NO_CHEATS = Object.freeze({ noBail: false, trickSpeed: 1.0 });

/**
 * Cheats for a rider name. Trimmed and case-insensitive; internal runs of
 * whitespace collapse so "James   Paterson" still counts.
 */
export function cheatsFor(name) {
  const n = String(name ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
  if (n === EGG) return { noBail: true, trickSpeed: 1.5 };
  return { noBail: false, trickSpeed: 1.0 };
}

// ---------------------------------------------------------------------------
// deterministic rng (private — never perturbs the shared mathx stream)
// ---------------------------------------------------------------------------

function makeRng(seedValue) {
  let x = (seedValue >>> 0) || 0x9e3779b9;
  return () => {
    x ^= x << 13; x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5; x >>>= 0;
    return x / 4294967296;
  };
}

function hashString(s) {
  let h = 0x811c9dc5;
  const str = String(s);
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/**
 * Deterministic random profile. The same seed always produces the same rider.
 * `opts`: number seed, or { seed, name, keepName, keepBike, keepBody }.
 */
export function randomizeProfile(base, opts = {}) {
  const o = typeof opts === 'number' ? { seed: opts } : (opts || {});
  const src = normalizeProfile(base);
  const seedValue = Number.isFinite(o.seed) ? (o.seed >>> 0) : hashString(src.id + '|' + src.name);
  const r = makeRng(seedValue);
  const p = clone(src);

  const one = (arr) => arr[Math.floor(r() * arr.length) % arr.length];
  const chance = (t) => r() < t;
  const rangeOf = (g) => coerceSlider(g, g.min + r() * (g.max - g.min));

  if (!o.keepBody) {
    p.gender = one(GENDERS).id;
    p.height = rangeOf(GROUP_BY_KEY.get('height'));
    p.build = rangeOf(GROUP_BY_KEY.get('build'));
    p.skin = one(SKIN).id;
  }

  // --- face: keep hair and facial hair reading as one head of hair ---------
  // indices 0..14 are natural colours, 15+ are dyes — dyes stay rare
  const NATURAL = HAIR_COLOURS.slice(0, 15);
  const hairStyle = one(HAIR_STYLES);
  const naturalColour = one(NATURAL);
  const dyed = chance(0.16);
  const hairColour = dyed ? one(HAIR_COLOURS.slice(15)).id : naturalColour.id;
  p.hair = { style: hairStyle.id, colour: hairColour };

  const wantsBeard = p.gender === 'female' ? chance(0.04) : chance(0.5);
  const beard = wantsBeard ? one(FACIAL_HAIR.slice(1)) : FACIAL_HAIR[0];
  p.facialHair = {
    style: beard.id,
    // a beard follows the head unless the head is dyed, and is never dyed itself
    colour: dyed ? naturalColour.id : (chance(0.75) ? hairColour : one(NATURAL).id),
  };

  p.headwear = one(HEADWEAR).id;
  p.headwearColour = one(CLOTH).id;

  // --- outfit: one accent runs through the whole fit ----------------------
  const accent = one(ACCENT).id;
  const top = one(TOPS);
  p.top = { style: top.id, colour: one(CLOTH).id, accent, graphic: one(GRAPHICS).id };
  p.bottom = { style: one(BOTTOMS).id, colour: one(DENIM).id };
  p.shoes = { style: one(SHOES).id, colour: one(SHOE_COLOURS).id, laces: chance(0.35) ? accent : one(LACES).id };
  p.gloves = { on: chance(0.45), colour: chance(0.4) ? accent : one(CLOTH).id };

  // pads cluster with a helmet — a park rider in full kit or none at all
  const helmeted = p.headwear === 'helmet';
  const padBias = helmeted ? 0.62 : 0.16;
  p.pads = { knee: chance(padBias), elbow: chance(padBias * 0.8), shin: chance(padBias * 0.45) };

  if (!o.keepBike) {
    p.bike = {
      frame: one(FRAMES).id,
      rims: one(RIMS).id,
      tyres: one(TYRES).id,
      grips: chance(0.3) ? accent : one(GRIP_COLOURS).id,
      seat: one(SEATS).id,
      pegs: one(PEGS).id,
      chrome: one(HARDWARE).id,
      decals: one(DECAL_SETS).id,
    };
  }

  if (o.name) p.name = sanitizeName(o.name);

  const out = normalizeProfile(p, { id: p.id });
  // timestamps are metadata, not appearance: carrying them through keeps the
  // whole returned object byte-identical for a given seed
  out.created = Number.isFinite(base && base.created) ? base.created : 0;
  out.updated = Number.isFinite(base && base.updated) ? base.updated : out.created;
  return out;
}

// ---------------------------------------------------------------------------
// storage
// ---------------------------------------------------------------------------

function storage() {
  try { return globalThis.localStorage || null; } catch (err) { return null; }
}

function readRaw(key) {
  const st = storage();
  if (!st) return null;
  let raw = null;
  try { raw = st.getItem(key); } catch (err) { return null; }
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (err) { return null; }
}

/**
 * Read whatever is in storage and pull it up to the current envelope.
 * Understands: the current { version, activeId, profiles[] }, a bare array of
 * profiles, a single flat profile object, and the two legacy keys.
 */
function loadStore() {
  let raw = readRaw(STORAGE_KEY);
  if (!raw) {
    for (const k of LEGACY_KEYS) {
      raw = readRaw(k);
      if (raw) break;
    }
  }
  const empty = { version: PROFILE_VERSION, activeId: null, profiles: [] };
  if (!raw) return empty;

  let data = raw;
  if (Array.isArray(data)) data = { profiles: data };
  if (!data || typeof data !== 'object') return empty;

  let list = data.profiles || data.riders || data.list || null;
  if (!Array.isArray(list)) {
    // a single profile stored on its own (v1)
    list = (data.name !== undefined || data.top !== undefined || data.bike !== undefined) ? [data] : [];
  }

  const seen = new Set();
  const profiles = [];
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue;
    const p = normalizeProfile(entry);
    if (seen.has(p.id)) p.id = newId();
    seen.add(p.id);
    profiles.push(p);
  }

  let activeId = typeof data.activeId === 'string' ? data.activeId
    : typeof data.active === 'string' ? data.active : null;
  if (activeId && !profiles.some((p) => p.id === activeId)) activeId = null;
  if (!activeId && profiles.length) activeId = profiles[0].id;

  return { version: PROFILE_VERSION, activeId, profiles };
}

function writeStore(store) {
  const st = storage();
  if (!st) return false;
  try {
    st.setItem(STORAGE_KEY, JSON.stringify({
      version: PROFILE_VERSION,
      activeId: store.activeId,
      profiles: store.profiles,
      saved: Date.now(),
    }));
    return true;
  } catch (err) {
    return false;                              // private mode / quota — stay in memory
  }
}

// ---------------------------------------------------------------------------
// createCustomization
// ---------------------------------------------------------------------------

/**
 * The rider profile service.
 *
 *   const cz = createCustomization(ctx);
 *   cz.profile            // the active profile (live getter)
 *   cz.profiles           // every saved profile (live array)
 *   cz.load(id)           // switch active profile, applies + persists
 *   cz.save(profile?)     // write the active (or given) profile back
 *   cz.create(name?)      // new profile from the default, becomes active
 *   cz.remove(id)         // delete; always leaves at least one profile
 *   cz.randomize(opts?)   // deterministic re-roll of the active profile
 *   cz.applyTo(rider)     // push the profile at the mesh + publish the cheats
 *   cz.cheatsFor(name)    // { noBail, trickSpeed }
 *   cz.validate(profile)  // { ok, errors, warnings, profile }
 *
 * `ctx` is optional; without it the service still works (no ctx publishing).
 */
export function createCustomization(ctx) {
  const store = loadStore();

  if (!store.profiles.length) {
    const first = freshProfile(DEFAULT_PROFILE);
    store.profiles.push(first);
    store.activeId = first.id;
  }
  if (!store.activeId) store.activeId = store.profiles[0].id;

  const state = {
    profile: store.profiles.find((p) => p.id === store.activeId) || store.profiles[0],
    rider: null,
    rollCount: 0,
  };

  const listeners = new Set();

  // --- the live cheat block ------------------------------------------------
  // ONE object for the life of the service, mutated in place and never swapped.
  // bikePhysics/tricks read it through ctx every frame, but the settings screen,
  // the HUD or a future consumer may well grab the reference once at
  // construction — replacing the object would leave them frozen on whatever the
  // name happened to be at boot, which is how the cheat used to get stuck on.
  const liveCheats = { ...NO_CHEATS };
  let cheatName = null;                     // the name liveCheats was derived from

  /**
   * Re-derive the cheats from the CURRENT active name. Cheap enough (a string
   * identity check on the hot path) to sit behind the ctx accessor, so the block
   * is correct even when a name is changed by a path that forgets to publish —
   * a text field writing straight into `customization.profile.name`, say.
   */
  function syncCheats() {
    const name = (state.profile && state.profile.name) || '';
    if (name === cheatName) return liveCheats;
    cheatName = name;
    const next = cheatsFor(name);
    for (const k of Object.keys(liveCheats)) if (!(k in next)) delete liveCheats[k];
    for (const k of Object.keys(next)) liveCheats[k] = next[k];
    return liveCheats;
  }

  const readCheats = () => syncCheats();

  /**
   * Hang `cheats` off `owner` as an accessor onto the one live block, so the
   * value can never be stale and the identity never changes. Re-installed on
   * every publish in case ctx.player was rebuilt underneath us.
   */
  function installCheats(owner) {
    const d = Object.getOwnPropertyDescriptor(owner, 'cheats');
    if (d && d.get === readCheats) return;
    try {
      Object.defineProperty(owner, 'cheats', {
        configurable: true,
        enumerable: true,
        get: readCheats,
        set(v) {
          // An explicit override still lands on the live block rather than
          // replacing it; the next name change re-derives over the top.
          if (!v || typeof v !== 'object') return;
          syncCheats();
          for (const k of Object.keys(v)) liveCheats[k] = v[k];
        },
      });
    } catch (err) {
      owner.cheats = syncCheats();          // sealed object — plain field, still live-ish
    }
  }

  function emit(reason) {
    publish();
    for (const fn of listeners) {
      try { fn(state.profile, reason); } catch (err) { /* a listener must not break the model */ }
    }
    if (ctx && typeof ctx.emit === 'function') {
      try { ctx.emit('rider-profile', { profile: state.profile, reason }); } catch (err) { /* no bus */ }
    }
  }

  /** Publish the profile + cheats onto ctx so physics/tricks read them for free. */
  function publish() {
    syncCheats();
    if (!ctx) return;
    if (!ctx.player || typeof ctx.player !== 'object') ctx.player = {};
    ctx.player.profile = state.profile;
    installCheats(ctx.player);
  }

  function persist() {
    store.activeId = state.profile.id;
    return writeStore(store);
  }

  function indexOf(id) {
    return store.profiles.findIndex((p) => p.id === id);
  }

  // -------------------------------------------------------------------------
  // public API
  // -------------------------------------------------------------------------

  const api = {
    STORAGE_KEY,
    DEFAULT_PROFILE,
    OPTIONS,
    OPTION_GROUPS,
    CATEGORIES,

    /** Every saved profile. Same array instance for the life of the service. */
    profiles: store.profiles,

    /** Switch to a profile by id (or index, or the profile object itself). */
    load(id) {
      let next = null;
      if (typeof id === 'number') next = store.profiles[id] || null;
      else if (id && typeof id === 'object') next = store.profiles[indexOf(id.id)] || null;
      else if (typeof id === 'string') next = store.profiles[indexOf(id)] || null;
      if (!next) return state.profile;
      state.profile = next;
      persist();
      if (state.rider) api.applyTo(state.rider);
      else emit('load');
      return state.profile;
    },

    /**
     * Persist the active profile (or `profile`, which is normalised and merged in
     * by id). Returns the stored profile.
     */
    save(profile) {
      let p = state.profile;
      if (profile && profile !== state.profile) {
        p = normalizeProfile(profile, { id: profile.id || state.profile.id });
        const i = indexOf(p.id);
        if (i >= 0) store.profiles[i] = p;
        else store.profiles.push(p);
        state.profile = p;
      } else {
        // the creator screen edits the live object; re-normalise before writing
        const i = indexOf(p.id);
        p = normalizeProfile(p, { id: p.id });
        if (i >= 0) store.profiles[i] = p;
        else store.profiles.push(p);
        state.profile = p;
      }
      state.profile.updated = Date.now();
      persist();
      emit('save');
      return state.profile;
    },

    /**
     * New profile. `init` may be a name, or a partial profile.
     * Becomes the active profile.
     */
    create(init) {
      const base = typeof init === 'string' || init === undefined
        ? { ...clone(DEFAULT_PROFILE), name: typeof init === 'string' ? init : uniqueName() }
        : { ...clone(DEFAULT_PROFILE), ...clone(init) };
      if (typeof init === 'object' && init && !init.name) base.name = uniqueName();
      const p = freshProfile(base);
      store.profiles.push(p);
      state.profile = p;
      persist();
      if (state.rider) api.applyTo(state.rider);
      else emit('create');
      return p;
    },

    /** Delete a profile. There is always at least one left. */
    remove(id) {
      const target = id === undefined ? state.profile.id : (typeof id === 'object' && id ? id.id : id);
      const i = typeof target === 'number' ? target : indexOf(target);
      if (i < 0 || i >= store.profiles.length) return false;
      const wasActive = store.profiles[i].id === state.profile.id;
      store.profiles.splice(i, 1);
      if (!store.profiles.length) {
        store.profiles.push(freshProfile(DEFAULT_PROFILE));
      }
      if (wasActive) state.profile = store.profiles[Math.min(i, store.profiles.length - 1)];
      persist();
      if (wasActive && state.rider) api.applyTo(state.rider);
      else emit('remove');
      return true;
    },

    /** Copy a profile under a new id + name. */
    duplicate(id) {
      const src = id === undefined ? state.profile : store.profiles[indexOf(typeof id === 'object' && id ? id.id : id)];
      if (!src) return state.profile;
      const p = freshProfile({ ...clone(src), name: uniqueName(src.name) });
      store.profiles.push(p);
      state.profile = p;
      persist();
      if (state.rider) api.applyTo(state.rider);
      else emit('duplicate');
      return p;
    },

    /** Rename the active (or given) profile — this is what arms the cheats. */
    rename(name, id) {
      const p = id === undefined ? state.profile : store.profiles[indexOf(id)];
      if (!p) return state.profile;
      p.name = sanitizeName(name);
      p.updated = Date.now();
      persist();
      emit('rename');
      return p;
    },

    /**
     * Deterministic re-roll of the active profile. Same seed -> same rider;
     * with no seed it walks a repeatable per-profile sequence.
     */
    randomize(opts) {
      const o = typeof opts === 'number' ? { seed: opts } : { ...(opts || {}) };
      if (!Number.isFinite(o.seed)) {
        o.seed = hashString(state.profile.id + '#' + state.rollCount);
        state.rollCount++;
      }
      if (o.keepName === undefined) o.keepName = true;
      const rolled = randomizeProfile(state.profile, o);
      rolled.id = state.profile.id;
      rolled.created = state.profile.created;
      rolled.updated = Date.now();
      if (o.keepName) rolled.name = state.profile.name;
      const i = indexOf(rolled.id);
      if (i >= 0) store.profiles[i] = rolled;
      state.profile = rolled;
      persist();
      if (state.rider) api.applyTo(state.rider);
      else emit('randomize');
      return rolled;
    },

    /**
     * Push the active profile at a rider built by `bike.js`, and publish the
     * profile + cheats on ctx. Degrades gracefully: a rider with no
     * `applyProfile` still gets the profile stashed where it can find it.
     */
    applyTo(rider, profile) {
      const p = profile ? api.select(profile) : state.profile;
      if (rider) state.rider = rider;
      publish();
      const target = rider || state.rider;
      if (target) {
        try {
          if (typeof target.applyProfile === 'function') target.applyProfile(p);
          else if (typeof target.setProfile === 'function') target.setProfile(p);
          else {
            target.profile = p;
            if (target.group) {
              target.group.userData = target.group.userData || {};
              target.group.userData.profile = p;
            }
          }
        } catch (err) {
          // a broken rebuild must never take the session down; keep the old mesh
          target.profile = p;
        }
      }
      for (const fn of listeners) {
        try { fn(p, 'apply'); } catch (err) { /* ignore */ }
      }
      if (ctx && typeof ctx.emit === 'function') {
        try { ctx.emit('rider-profile', { profile: p, reason: 'apply' }); } catch (err) { /* no bus */ }
      }
      return p;
    },

    /** Make `profile` the active one without touching storage order. */
    select(profile) {
      if (!profile) return state.profile;
      const i = indexOf(profile.id);
      const p = normalizeProfile(profile, { id: profile.id });
      if (i >= 0) store.profiles[i] = p;
      else store.profiles.push(p);
      state.profile = p;
      persist();
      // A different profile means a different name, which means different cheats.
      // `applyTo` publishes again right after this; publishing twice is free.
      publish();
      return p;
    },

    // --- field level editing, for a data-driven creator screen -------------

    /** Read one option by group key or profile path. */
    get(keyOrPath) {
      const g = groupFor(keyOrPath);
      return getAt(state.profile, g ? g.path : keyOrPath);
    },

    /**
     * Write one option by group key or profile path. Coerced through the group,
     * so a bad value can never enter the profile. Applies live.
     */
    set(keyOrPath, value, opts = {}) {
      const g = groupFor(keyOrPath);
      if (!g) {
        if (keyOrPath === 'name') return api.rename(value);
        return state.profile;
      }
      const coerced = g.kind === 'slider' ? coerceSlider(g, value)
        : g.kind === 'swatch' ? coerceSwatch(g, value)
          : coerceChoice(g, value);
      setAt(state.profile, g.path, coerced);
      state.profile.updated = Date.now();
      if (opts.persist !== false) persist();
      if (state.rider && opts.apply !== false) api.applyTo(state.rider);
      else emit('set');
      return state.profile;
    },

    /** Step to the next/previous value of a group — gamepad d-pad navigation. */
    cycle(keyOrPath, dir = 1, opts) {
      const g = groupFor(keyOrPath);
      if (!g) return state.profile;
      const cur = getAt(state.profile, g.path);
      if (g.kind === 'slider') {
        return api.set(g.key, (Number(cur) || g.default) + g.step * Math.sign(dir || 1), opts);
      }
      let i = g.values.findIndex((v) => v.id === cur);
      if (i < 0) i = 0;
      const n = g.values.length;
      const next = g.values[(((i + Math.sign(dir || 1)) % n) + n) % n];
      return api.set(g.key, next.id, opts);
    },

    /** Index of the current value inside its group (-1 for sliders). */
    indexIn(keyOrPath) {
      const g = groupFor(keyOrPath);
      if (!g || !g.values) return -1;
      return g.values.findIndex((v) => v.id === getAt(state.profile, g.path));
    },

    /** Reset the active profile to the factory rider, keeping id and name. */
    reset() {
      const fresh = normalizeProfile(DEFAULT_PROFILE, { id: state.profile.id });
      fresh.id = state.profile.id;
      fresh.name = state.profile.name;
      fresh.created = state.profile.created;
      const i = indexOf(fresh.id);
      if (i >= 0) store.profiles[i] = fresh;
      state.profile = fresh;
      persist();
      if (state.rider) api.applyTo(state.rider);
      else emit('reset');
      return fresh;
    },

    /** Drop every stored profile (settings screen "reset all progress"). */
    clearAll() {
      store.profiles.length = 0;
      const fresh = freshProfile(DEFAULT_PROFILE);
      store.profiles.push(fresh);
      state.profile = fresh;
      persist();
      if (state.rider) api.applyTo(state.rider);
      else emit('clear');
      return fresh;
    },

    // --- catalogue helpers -------------------------------------------------
    groupFor,
    valuesFor,
    optionFor,
    prettyName,
    hexString,
    toColour,
    describeProfile,
    materialPlan: (p) => materialPlan(p || state.profile),
    riderMetrics: (p) => riderMetrics(p || state.profile),

    validate,
    normalize: normalizeProfile,
    cheatsFor,

    /** Subscribe to profile changes. Returns an unsubscribe function. */
    subscribe(fn) {
      if (typeof fn !== 'function') return () => {};
      listeners.add(fn);
      return () => listeners.delete(fn);
    },

    dispose() {
      listeners.clear();
      state.rider = null;
    },
  };

  /** "Rookie", "Rookie 2", ... — never collides with an existing profile. */
  function uniqueName(base) {
    const root = sanitizeName(base || DEFAULT_PROFILE.name).replace(/\s+\d+$/, '');
    const taken = new Set(store.profiles.map((p) => p.name.toLowerCase()));
    if (!taken.has(root.toLowerCase())) return root;
    for (let i = 2; i < 100; i++) {
      const candidate = sanitizeName(`${root} ${i}`);
      if (!taken.has(candidate.toLowerCase())) return candidate;
    }
    return root;
  }

  Object.defineProperty(api, 'profile', {
    enumerable: true,
    get() { return state.profile; },
    set(v) { api.select(v); },
  });
  Object.defineProperty(api, 'cheats', {
    enumerable: true,
    get() { return syncCheats(); },
  });
  Object.defineProperty(api, 'activeId', {
    enumerable: true,
    get() { return state.profile.id; },
  });

  publish();
  // write the current envelope straight back, so a profile that arrived from a
  // legacy key or a repaired blob is durable even if the player never edits it
  persist();
  return api;
}

export default createCustomization;
