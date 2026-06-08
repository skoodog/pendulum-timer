// =============================================================================
// NFL BLITZ CLONE - PLAY FORMATIONS & ROUTES
// =============================================================================

// Positions are offsets from the line of scrimmage and center of field
// x: offset from center (negative = left, positive = right)
// y: offset from LOS (negative = behind LOS for offense, positive = ahead for defense)
// For offense attacking upward (negative Y direction):
//   behind LOS = positive Y offset (further from opponent endzone)
//   routes go negative Y (toward opponent endzone)

const OFFENSIVE_PLAYS = [
    {
        name: 'SHORT PASS',
        icon: '>>>',
        formation: [
            { role: 'QB',  x: 0,   y: 40 },
            { role: 'C',   x: 0,   y: 15 },
            { role: 'WR',  x: -200, y: 5 },
            { role: 'WR',  x: 200,  y: 5 },
            { role: 'RB',  x: 40,  y: 55 },
            { role: 'OL',  x: -40, y: 15 },
            { role: 'OL',  x: 40,  y: 15 },
        ],
        routes: [
            null, // QB stays
            null, // C blocks
            // WR left: slant in
            [{ x: -180, y: -60 }, { x: -100, y: -120 }],
            // WR right: slant in
            [{ x: 180, y: -60 }, { x: 100, y: -120 }],
            // RB: flat right
            [{ x: 120, y: -30 }, { x: 180, y: -60 }],
            null, // OL blocks
            null, // OL blocks
        ]
    },
    {
        name: 'LONG PASS',
        icon: '>>>>>>',
        formation: [
            { role: 'QB',  x: 0,   y: 50 },
            { role: 'C',   x: 0,   y: 15 },
            { role: 'WR',  x: -220, y: 0 },
            { role: 'WR',  x: 220,  y: 0 },
            { role: 'WR',  x: -100, y: 5 },
            { role: 'OL',  x: -40, y: 15 },
            { role: 'OL',  x: 40,  y: 15 },
        ],
        routes: [
            null, // QB
            null, // C blocks
            // WR left: go deep
            [{ x: -220, y: -80 }, { x: -200, y: -200 }, { x: -180, y: -320 }],
            // WR right: go deep
            [{ x: 220, y: -80 }, { x: 200, y: -200 }, { x: 180, y: -320 }],
            // Slot: post route
            [{ x: -100, y: -80 }, { x: -40, y: -180 }, { x: 0, y: -300 }],
            null,
            null,
        ]
    },
    {
        name: 'RUN LEFT',
        icon: '<-RUN',
        formation: [
            { role: 'QB',  x: 0,   y: 40 },
            { role: 'C',   x: 0,   y: 15 },
            { role: 'RB',  x: 0,   y: 60 },
            { role: 'WR',  x: -220, y: 0 },
            { role: 'OL',  x: -40, y: 15 },
            { role: 'OL',  x: 40,  y: 15 },
            { role: 'OL',  x: -80, y: 18 },
        ],
        routes: [
            null, // QB hands off
            null, // C blocks
            // RB runs left
            [{ x: -80, y: 30 }, { x: -160, y: -20 }, { x: -180, y: -120 }],
            // WR blocks
            null,
            null,
            null,
            null,
        ],
        isRun: true,
        runDirection: -1
    },
    {
        name: 'RUN RIGHT',
        icon: 'RUN->',
        formation: [
            { role: 'QB',  x: 0,   y: 40 },
            { role: 'C',   x: 0,   y: 15 },
            { role: 'RB',  x: 0,   y: 60 },
            { role: 'WR',  x: 220,  y: 0 },
            { role: 'OL',  x: -40, y: 15 },
            { role: 'OL',  x: 40,  y: 15 },
            { role: 'OL',  x: 80,  y: 18 },
        ],
        routes: [
            null,
            null,
            // RB runs right
            [{ x: 80, y: 30 }, { x: 160, y: -20 }, { x: 180, y: -120 }],
            null,
            null,
            null,
            null,
        ],
        isRun: true,
        runDirection: 1
    }
];

const DEFENSIVE_PLAYS = [
    {
        name: 'MAN COVER',
        icon: 'MAN',
        formation: [
            { role: 'CB', x: -200, y: -10 },
            { role: 'CB', x: 200,  y: -10 },
            { role: 'SS', x: -80,  y: -60 },
            { role: 'FS', x: 80,   y: -60 },
            { role: 'LB', x: 0,    y: -30 },
            { role: 'DL', x: -50,  y: -5 },
            { role: 'DL', x: 50,   y: -5 },
        ],
        type: 'man'
    },
    {
        name: 'ZONE',
        icon: 'ZON',
        formation: [
            { role: 'CB', x: -200, y: -20 },
            { role: 'CB', x: 200,  y: -20 },
            { role: 'SS', x: -100, y: -100 },
            { role: 'FS', x: 100,  y: -100 },
            { role: 'LB', x: 0,    y: -40 },
            { role: 'DL', x: -40,  y: -5 },
            { role: 'DL', x: 40,   y: -5 },
        ],
        type: 'zone',
        zones: [
            { x: -200, y: -80 },
            { x: 200,  y: -80 },
            { x: -120, y: -180 },
            { x: 120,  y: -180 },
            { x: 0,    y: -100 },
            null,
            null,
        ]
    },
    {
        name: 'BLITZ',
        icon: 'BLZ',
        formation: [
            { role: 'CB', x: -180, y: -10 },
            { role: 'CB', x: 180,  y: -10 },
            { role: 'LB', x: -80,  y: -15 },
            { role: 'LB', x: 80,   y: -15 },
            { role: 'LB', x: 0,    y: -20 },
            { role: 'DL', x: -40,  y: -5 },
            { role: 'DL', x: 40,   y: -5 },
        ],
        type: 'blitz'
    },
    {
        name: 'GOAL LINE',
        icon: 'GL',
        formation: [
            { role: 'CB', x: -160, y: -5 },
            { role: 'CB', x: 160,  y: -5 },
            { role: 'LB', x: -80,  y: -10 },
            { role: 'LB', x: 80,   y: -10 },
            { role: 'DL', x: 0,    y: -5 },
            { role: 'DL', x: -40,  y: -5 },
            { role: 'DL', x: 40,   y: -5 },
        ],
        type: 'goalline'
    }
];
