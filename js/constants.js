// =============================================================================
// NFL BLITZ CLONE - CONSTANTS & CONFIGURATION
// =============================================================================

const GAME_WIDTH = 1280;
const GAME_HEIGHT = 720;

// World-space field dimensions
const PIXELS_PER_YARD = 10;
const TOTAL_YARDS = 120;
const FIELD_YARDS = 100;
const ENDZONE_YARDS = 10;
const TOTAL_FIELD_LENGTH = TOTAL_YARDS * PIXELS_PER_YARD;
const FIELD_WORLD_WIDTH = 700; // width of field in world pixels
const FIELD_WORLD_LEFT = 50;
const FIELD_WORLD_RIGHT = FIELD_WORLD_LEFT + FIELD_WORLD_WIDTH;
const FIELD_WORLD_TOP = 0;
const FIELD_WORLD_BOTTOM = TOTAL_FIELD_LENGTH;

const YARDS_FOR_FIRST_DOWN = 30;

// Player
const PLAYER_RADIUS = 14;
const PLAYER_SPEED = 2.8;
const PLAYER_SPRINT_SPEED = 4.0;
const QB_SPEED = 2.4;
const RECEIVER_SPEED = 3.0;
const DEFENDER_SPEED = 2.8;
const TACKLE_DISTANCE = 24;
const BALL_SPEED = 7;
const PLAYERS_PER_TEAM = 7;

// Timing
const QUARTER_TIME = 120;
const PLAY_CLOCK = 15;
const SNAP_DELAY = 300;
const POST_PLAY_DELAY = 2000;
const HALFTIME_DELAY = 4000;

// Scoring
const TOUCHDOWN_POINTS = 6;
const EXTRA_POINT_POINTS = 1;
const FIELD_GOAL_POINTS = 3;
const SAFETY_POINTS = 2;

// Physics
const FRICTION = 0.93;

// Camera
const CAMERA_SMOOTH = 0.07;

// Game states
const STATE_TITLE = 'title';
const STATE_TEAM_SELECT = 'team_select';
const STATE_COIN_TOSS = 'coin_toss';
const STATE_PLAY_SELECT = 'play_select';
const STATE_FORMATION = 'formation';
const STATE_PLAYING = 'playing';
const STATE_TACKLE = 'tackle';
const STATE_SCORING = 'scoring';
const STATE_EXTRA_POINT = 'extra_point';
const STATE_HALFTIME = 'halftime';
const STATE_QUARTER_END = 'quarter_end';
const STATE_GAME_OVER = 'game_over';
const STATE_KICKOFF = 'kickoff';
const STATE_TURNOVER = 'turnover';
const STATE_CONTROLS = 'controls';

// Teams
const TEAMS = [
    { name: 'DESTROYERS', abbr: 'DES', primary: '#CC0000', secondary: '#FFFFFF', accent: '#FFD700' },
    { name: 'THUNDER',    abbr: 'THU', primary: '#003DA5', secondary: '#FFFFFF', accent: '#FF6600' },
    { name: 'VIPERS',     abbr: 'VIP', primary: '#006400', secondary: '#FFD700', accent: '#FFFFFF' },
    { name: 'WOLVES',     abbr: 'WLV', primary: '#2F2F2F', secondary: '#C0C0C0', accent: '#FF4500' },
    { name: 'INFERNO',    abbr: 'INF', primary: '#FF4500', secondary: '#000000', accent: '#FFD700' },
    { name: 'STORM',      abbr: 'STM', primary: '#4B0082', secondary: '#00CED1', accent: '#FFFFFF' },
    { name: 'TITANS',     abbr: 'TIT', primary: '#B8860B', secondary: '#FFFFFF', accent: '#8B0000' },
    { name: 'FROST',      abbr: 'FRO', primary: '#00BFFF', secondary: '#FFFFFF', accent: '#000080' },
];

// Directions: in our world, "down the field" toward opponent endzone
// Team 1 (player) attacks UPWARD (decreasing Y), Team 2 attacks DOWNWARD (increasing Y)
const DIR_UP = -1;
const DIR_DOWN = 1;
