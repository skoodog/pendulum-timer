// =============================================================================
// NFL BLITZ CLONE - MAIN GAME ENGINE
// =============================================================================

class Game {
    constructor() {
        this.canvas = document.getElementById('gameCanvas');
        this.ctx = this.canvas.getContext('2d');
        this.canvas.width = GAME_WIDTH;
        this.canvas.height = GAME_HEIGHT;

        this.input = new InputManager();
        this.audio = new AudioManager();
        this.field = new FieldRenderer();
        this.ui = new UIRenderer();
        this.ai = new AIController();
        this.particles = new ParticleSystem();
        this.screenShake = new ScreenShake();
        this.flashText = new FlashText();

        // Game state
        this.state = STATE_TITLE;
        this.stateTimer = 0;

        // Teams
        this.team1Index = 0; // player
        this.team2Index = 1; // CPU
        this.playerTeam = 0; // 0 = team1, 1 = team2

        // Score
        this.score = [0, 0];
        this.quarter = 1;
        this.gameTime = QUARTER_TIME;
        this.clockRunning = false;

        // Possession
        this.possession = 0; // which team has ball (0 or 1)
        this.down = 1;
        this.yardsToGo = YARDS_FOR_FIRST_DOWN;
        this.losYard = 25; // line of scrimmage in yards (0-100 from team 0's endzone)
        this.firstDownYard = 55; // yard needed for first down

        // Direction: team 0 attacks toward yard 100 (upward, -Y), team 1 attacks toward yard 0 (downward, +Y)
        this.attackDir = -1; // -1 means moving toward lower Y (which is higher yard number)

        // Players
        this.offensePlayers = [];
        this.defensePlayers = [];
        this.ballCarrier = null;
        this.controlledPlayer = null;
        this.ball = null; // Football in air
        this.ballInAir = false;
        this.targetReceiver = null;

        // Play management
        this.offensePlayChoice = 0;
        this.defensePlayChoice = 0;
        this.cpuPlayChoice = 0;
        this.playStarted = false;
        this.snapTimer = 0;

        // Camera
        this.camX = 0;
        this.camY = 0;
        this.targetCamX = 0;
        this.targetCamY = 0;

        // Coin toss
        this.coinTossResult = false;
        this.coinTossTimer = 0;

        // Kickoff
        this.kickoffTimer = 0;

        // Extra point
        this.extraPointTimer = 0;

        // Switch player cooldown
        this.switchCooldown = 0;

        // Run play handoff
        this.handoffTimer = -1;
        this.pendingHandoff = false;

        // Start game loop
        this.lastTime = performance.now();
        this.accumulator = 0;
        this.frameTime = 1000 / 60;
        this.loop();
    }

    get losWorldY() {
        return yardToWorldY(this.losYard);
    }

    loop() {
        const now = performance.now();
        const delta = now - this.lastTime;
        this.lastTime = now;

        this.accumulator += delta;
        while (this.accumulator >= this.frameTime) {
            this.update();
            this.accumulator -= this.frameTime;
        }
        this.render();
        requestAnimationFrame(() => this.loop());
    }

    update() {
        this.stateTimer++;
        this.input.pollGamepad();

        switch (this.state) {
            case STATE_TITLE:
                this.updateTitle();
                break;
            case STATE_TEAM_SELECT:
                this.updateTeamSelect();
                break;
            case STATE_COIN_TOSS:
                this.updateCoinToss();
                break;
            case STATE_PLAY_SELECT:
                this.updatePlaySelect();
                break;
            case STATE_FORMATION:
                this.updateFormation();
                break;
            case STATE_PLAYING:
                this.updatePlaying();
                break;
            case STATE_TACKLE:
                this.updateTackle();
                break;
            case STATE_SCORING:
                this.updateScoring();
                break;
            case STATE_EXTRA_POINT:
                this.updateExtraPoint();
                break;
            case STATE_KICKOFF:
                this.updateKickoff();
                break;
            case STATE_TURNOVER:
                this.updateTurnover();
                break;
            case STATE_HALFTIME:
                this.updateHalftime();
                break;
            case STATE_QUARTER_END:
                this.updateQuarterEnd();
                break;
            case STATE_GAME_OVER:
                this.updateGameOver();
                break;
            case STATE_CONTROLS:
                this.updateControls();
                break;
        }

        this.particles.update();
        this.screenShake.update();
        this.flashText.update();
        if (this.switchCooldown > 0) this.switchCooldown--;
        this.input.clearFrame();
    }

    // =========================================================================
    // STATE UPDATES
    // =========================================================================

    updateTitle() {
        if (this.input.actionJustPressed('confirm')) {
            this.audio.init();
            this.audio.confirm();
            this.state = STATE_TEAM_SELECT;
            this.stateTimer = 0;
        }
        // C key or Y button opens controls
        if (this.input.justPressed('KeyC') || this.input.gamepadButtonsJustPressed[3]) {
            this.audio.init();
            this.audio.select();
            this.state = STATE_CONTROLS;
            this.stateTimer = 0;
        }
    }

    updateTeamSelect() {
        if (this.input.actionJustPressed('move_left')) {
            this.ui.selectedTeam1 = (this.ui.selectedTeam1 - 1 + TEAMS.length) % TEAMS.length;
            this.audio.select();
        }
        if (this.input.actionJustPressed('move_right')) {
            this.ui.selectedTeam1 = (this.ui.selectedTeam1 + 1) % TEAMS.length;
            this.audio.select();
        }
        if (this.input.actionJustPressed('move_up')) {
            this.ui.selectedTeam1 = (this.ui.selectedTeam1 - 4 + TEAMS.length) % TEAMS.length;
            this.audio.select();
        }
        if (this.input.actionJustPressed('move_down')) {
            this.ui.selectedTeam1 = (this.ui.selectedTeam1 + 4) % TEAMS.length;
            this.audio.select();
        }

        if (this.input.actionJustPressed('confirm')) {
            this.team1Index = this.ui.selectedTeam1;
            // CPU picks a different team
            this.team2Index = (this.team1Index + randInt(1, TEAMS.length - 1)) % TEAMS.length;
            this.audio.confirm();
            this.state = STATE_COIN_TOSS;
            this.stateTimer = 0;
            this.coinTossTimer = 0;
            this.coinTossResult = Math.random() < 0.5;
        }
    }

    updateCoinToss() {
        this.coinTossTimer++;
        if (this.coinTossTimer > 120) {
            if (this.input.actionJustPressed('confirm') || this.coinTossTimer > 200) {
                this.audio.confirm();
                // Set up game
                this.score = [0, 0];
                this.quarter = 1;
                this.gameTime = QUARTER_TIME;
                this.playerTeam = 0;

                if (this.coinTossResult) {
                    // Player receives
                    this.possession = 1; // team 2 kicks off
                    this.setupKickoff(1);
                } else {
                    // Player kicks off
                    this.possession = 0; // team 1 kicks off (player)
                    this.setupKickoff(0);
                }
            }
        }
    }

    updatePlaySelect() {
        const isPlayerOnOffense = this.possession === this.playerTeam;

        // CPU makes a choice (only once when entering this state)
        if (this.stateTimer === 1) {
            if (isPlayerOnOffense) {
                this.defensePlayChoice = this.ai.choosePlay(false);
            } else {
                this.cpuPlayChoice = this.ai.choosePlay(true);
            }
        }

        // Player input
        let currentSelection = isPlayerOnOffense ? this.offensePlayChoice : this.defensePlayChoice;
        const plays = isPlayerOnOffense ? OFFENSIVE_PLAYS : DEFENSIVE_PLAYS;

        if (this.input.actionJustPressed('move_left')) {
            currentSelection = (currentSelection - 1 + plays.length) % plays.length;
            this.audio.select();
        }
        if (this.input.actionJustPressed('move_right')) {
            currentSelection = (currentSelection + 1) % plays.length;
            this.audio.select();
        }
        // Number keys / gamepad D-pad for quick select
        if (this.input.actionJustPressed('pass_1')) { currentSelection = 0; this.audio.select(); }
        if (this.input.actionJustPressed('pass_2') && plays.length > 1) { currentSelection = 1; this.audio.select(); }
        if (this.input.actionJustPressed('pass_3') && plays.length > 2) { currentSelection = 2; this.audio.select(); }
        if (this.input.actionJustPressed('pass_4') && plays.length > 3) { currentSelection = 3; this.audio.select(); }

        if (isPlayerOnOffense) {
            this.offensePlayChoice = currentSelection;
        } else {
            this.defensePlayChoice = currentSelection;
        }

        // Confirm
        if (this.input.actionJustPressed('confirm')) {
            this.audio.confirm();
            if (isPlayerOnOffense) {
                this.offensePlayChoice = currentSelection;
            } else {
                this.defensePlayChoice = currentSelection;
            }
            this.setupFormation();
            this.state = STATE_FORMATION;
            this.stateTimer = 0;
            this.snapTimer = 0;
        }
    }

    updateFormation() {
        this.snapTimer++;
        // Players move to formation positions
        this.offensePlayers.forEach(p => p.update());
        this.defensePlayers.forEach(p => p.update());

        this.updateCamera();

        // Allow snap after delay
        if (this.snapTimer > 20) {
            if (this.input.actionJustPressed('confirm')) {
                this.startPlay();
            }
            // Auto-snap for CPU offense after delay
            if (this.possession !== this.playerTeam && this.snapTimer > 40) {
                this.startPlay();
            }
        }
    }

    updatePlaying() {
        // Game clock
        if (this.clockRunning) {
            this.gameTime -= 1 / 60;
            if (this.gameTime <= 0) {
                this.gameTime = 0;
                this.endQuarter();
                return;
            }
        }

        // Pending run handoff
        if (this.pendingHandoff) {
            this.handoffTimer--;
            if (this.handoffTimer <= 0) {
                this.pendingHandoff = false;
                const rb = this.offensePlayers.find(p => p.role === 'RB');
                const qb = this.offensePlayers.find(p => p.isQB);
                if (rb && qb && qb.hasBall) {
                    qb.hasBall = false;
                    rb.hasBall = true;
                    this.ballCarrier = rb;
                    if (this.controlledPlayer) this.controlledPlayer.isControlled = false;
                    this.controlledPlayer = rb;
                    rb.isControlled = true;
                }
            }
        }

        // Player input
        this.handlePlayerInput();

        // AI
        const isPlayerOnOffense = this.possession === this.playerTeam;
        if (isPlayerOnOffense) {
            this.ai.updateDefense(this.defensePlayers, this.offensePlayers, this.ball, this);
        } else {
            this.ai.updateOffense(this.offensePlayers, this.defensePlayers, this.ball, this);
            // Player's defense teammates use AI defense logic too
            this.ai.updateDefense(this.defensePlayers, this.offensePlayers, this.ball, this);
        }

        // Update ball in air
        if (this.ball && this.ball.active) {
            this.ball.update();
            this.checkBallCatch();
        }

        // Update players
        this.offensePlayers.forEach(p => {
            if (!p.isControlled && !p.hasBall) {
                // Route running for offense (player team)
                if (p.route && !p.routeComplete && !p.tackled) {
                    p.runRoute();
                }
            }
            p.update();
        });
        this.defensePlayers.forEach(p => p.update());

        // Check tackles
        this.checkTackles();

        // Check out of bounds
        this.checkOutOfBounds();

        // Check touchdown
        this.checkTouchdown();

        // Start clock after first movement
        if (!this.clockRunning) {
            this.clockRunning = true;
        }

        this.updateCamera();
    }

    updateTackle() {
        // stateTimer is incremented in update()
        this.offensePlayers.forEach(p => p.update());
        this.defensePlayers.forEach(p => p.update());

        if (this.stateTimer > 60) {
            this.endPlay();
        }
    }

    updateScoring() {
        // stateTimer is incremented in update()
        if (this.stateTimer > 120) {
            this.state = STATE_EXTRA_POINT;
            this.stateTimer = 0;
            this.extraPointTimer = 0;
        }
    }

    updateExtraPoint() {
        this.extraPointTimer++;
        // Auto-attempt: 90% success rate
        if (this.extraPointTimer === 30) {
            if (Math.random() < 0.9) {
                this.score[this.possession] += EXTRA_POINT_POINTS;
                this.flashText.show('EXTRA POINT!', 60, '#00FF00', 40);
            } else {
                this.flashText.show('NO GOOD!', 60, '#FF0000', 40);
            }
        }
        if (this.extraPointTimer > 90) {
            // Kickoff: scoring team kicks
            this.setupKickoff(this.possession);
        }
    }

    updateKickoff() {
        this.kickoffTimer++;

        // Auto kickoff animation
        if (this.kickoffTimer === 1) {
            this.flashText.show('KICKOFF!', 60, '#FFD700', 48);
            // Center camera on mid-field
            const centerX = (FIELD_WORLD_LEFT + FIELD_WORLD_RIGHT) / 2;
            const centerY = yardToWorldY(50);
            this.camX = centerX - GAME_WIDTH / 2;
            this.camY = centerY - GAME_HEIGHT / 2;
        }

        if (this.kickoffTimer > 60) {
            // Set up for receiving team
            const receivingTeam = this.possession === 0 ? 1 : 0;
            this.possession = receivingTeam;
            // Own 25 yard line: team 0's own 25 = yard 25, team 1's own 25 = yard 75
            this.losYard = this.possession === 0 ? 25 : 75;
            this.down = 1;
            this.updateFirstDown();
            this.state = STATE_PLAY_SELECT;
            this.stateTimer = 0;
            this.ai.reset();
        }
    }

    updateTurnover() {
        this.offensePlayers.forEach(p => p.update());
        this.defensePlayers.forEach(p => p.update());

        if (this.stateTimer > 90) {
            // Swap possession
            this.possession = this.possession === 0 ? 1 : 0;
            // LOS is where interception happened
            this.down = 1;
            this.updateFirstDown();
            this.state = STATE_PLAY_SELECT;
            this.stateTimer = 0;
            this.ai.reset();
        }
    }

    updateHalftime() {
        if (this.stateTimer > 180) {
            this.quarter = 3;
            this.gameTime = QUARTER_TIME;
            // Second half kickoff (team that kicked off first half now receives)
            const kickingTeam = this.coinTossResult ? 0 : 1;
            this.setupKickoff(kickingTeam);
        }
    }

    updateQuarterEnd() {
        if (this.stateTimer > 120) {
            this.quarter++;
            this.gameTime = QUARTER_TIME;
            if (this.quarter === 3) {
                this.state = STATE_HALFTIME;
                this.stateTimer = 0;
            } else if (this.quarter > 4) {
                this.state = STATE_GAME_OVER;
                this.stateTimer = 0;
            } else {
                // Continue with possession
                this.state = STATE_PLAY_SELECT;
                this.stateTimer = 0;
            }
        }
    }

    updateGameOver() {
        if (this.input.actionJustPressed('confirm')) {
            this.state = STATE_TITLE;
            this.stateTimer = 0;
        }
    }

    updateControls() {
        // Handled by UI; back button exits
        if (this.input.justPressed('Escape') || this.input.gamepadButtonsJustPressed[1]) {
            this.audio.confirm();
            this.state = STATE_TITLE;
            this.stateTimer = 0;
            return;
        }

        // Navigation
        if (this.input.actionJustPressed('move_up') && !this.input.rebinding) {
            this.ui.controlsSelection = Math.max(0, this.ui.controlsSelection - 1);
            this.audio.select();
        }
        if (this.input.actionJustPressed('move_down') && !this.input.rebinding) {
            const maxItems = Object.keys(ACTION_NAMES).length + 1; // +1 for reset
            this.ui.controlsSelection = Math.min(maxItems, this.ui.controlsSelection + 1);
            this.audio.select();
        }

        // Tab to switch between keyboard/gamepad column
        if (this.input.justPressed('Tab') && !this.input.rebinding) {
            this.ui.controlsColumn = this.ui.controlsColumn === 0 ? 1 : 0;
            this.audio.select();
        }

        // Confirm to rebind or reset
        if (this.input.actionJustPressed('confirm') && !this.input.rebinding) {
            const actions = Object.keys(ACTION_NAMES);
            if (this.ui.controlsSelection < actions.length) {
                const action = actions[this.ui.controlsSelection];
                const source = this.ui.controlsColumn === 0 ? 'keyboard' : 'gamepad';
                this.input.startRebind(action, source, () => {
                    this.audio.confirm();
                });
            } else if (this.ui.controlsSelection === actions.length) {
                // Reset to defaults
                this.input.resetBindings();
                this.audio.confirm();
                this.flashText.show('CONTROLS RESET', 60, '#00FF00', 36);
            } else {
                // Back
                this.audio.confirm();
                this.state = STATE_TITLE;
                this.stateTimer = 0;
            }
        }
    }

    // =========================================================================
    // GAMEPLAY LOGIC
    // =========================================================================

    handlePlayerInput() {
        if (!this.controlledPlayer || this.controlledPlayer.tackled) return;

        const move = this.input.getMoveVector();
        const speed = this.input.isSprinting() ? PLAYER_SPRINT_SPEED : PLAYER_SPEED;

        if (move.x !== 0 || move.y !== 0) {
            this.controlledPlayer.vx = move.x * speed;
            this.controlledPlayer.vy = move.y * speed;
            this.controlledPlayer.isControlled = true;
        }

        // Pass (click, gamepad X, or number keys when QB has ball on offense)
        const isPlayerOnOffense = this.possession === this.playerTeam;
        if (isPlayerOnOffense && this.controlledPlayer.hasBall && this.controlledPlayer.isQB) {
            const receivers = this.offensePlayers.filter(p => !p.isQB && !p.tackled && p.role !== 'OL' && p.role !== 'C');

            // Click to pass (mouse)
            if (this.input.mouseClicked) {
                const worldClickX = this.input.mouseX + this.camX;
                const worldClickY = this.input.mouseY + this.camY;
                let bestR = null;
                let bestDist = Infinity;
                receivers.forEach(r => {
                    const d = dist(r.x, r.y, worldClickX, worldClickY);
                    if (d < bestDist) {
                        bestDist = d;
                        bestR = r;
                    }
                });
                if (bestR) {
                    const leadX = bestR.x + bestR.vx * 10;
                    const leadY = bestR.y + bestR.vy * 10;
                    this.throwBall(this.controlledPlayer, leadX, leadY, bestR);
                }
            }

            // Gamepad pass click (X button) — throw to most open receiver
            if (this.input.gamepadPassClick && receivers.length > 0) {
                let bestR = null;
                let bestOpenness = -Infinity;
                receivers.forEach(r => {
                    let minDefDist = Infinity;
                    this.defensePlayers.forEach(d => {
                        const dd = dist(r.x, r.y, d.x, d.y);
                        if (dd < minDefDist) minDefDist = dd;
                    });
                    if (minDefDist > bestOpenness) {
                        bestOpenness = minDefDist;
                        bestR = r;
                    }
                });
                if (bestR) {
                    const leadX = bestR.x + bestR.vx * 10;
                    const leadY = bestR.y + bestR.vy * 10;
                    this.throwBall(this.controlledPlayer, leadX, leadY, bestR);
                }
            }

            // Number keys / gamepad D-pad to pass to specific receiver
            const passActions = ['pass_1', 'pass_2', 'pass_3', 'pass_4'];
            for (let i = 0; i < receivers.length && i < passActions.length; i++) {
                if (this.input.actionJustPressed(passActions[i])) {
                    const r = receivers[i];
                    const leadX = r.x + r.vx * 10;
                    const leadY = r.y + r.vy * 10;
                    this.throwBall(this.controlledPlayer, leadX, leadY, r);
                    break;
                }
            }
        }

        // Switch player
        if (this.input.actionJustPressed('switch_player') && this.switchCooldown <= 0) {
            this.switchControlledPlayer();
            this.switchCooldown = 15;
        }
    }

    switchControlledPlayer() {
        const isPlayerOnOffense = this.possession === this.playerTeam;
        const myPlayers = isPlayerOnOffense ? this.offensePlayers : this.defensePlayers;
        const available = myPlayers.filter(p => !p.tackled && p !== this.controlledPlayer);
        if (available.length === 0) return;

        // Switch to player nearest to ball carrier or ball
        let targetX, targetY;
        if (this.ball && this.ball.active) {
            targetX = this.ball.x;
            targetY = this.ball.y;
        } else if (this.ballCarrier) {
            targetX = this.ballCarrier.x;
            targetY = this.ballCarrier.y;
        } else {
            targetX = this.controlledPlayer.x;
            targetY = this.controlledPlayer.y;
        }

        let best = null;
        let bestDist = Infinity;
        available.forEach(p => {
            const d = dist(p.x, p.y, targetX, targetY);
            if (d < bestDist) {
                bestDist = d;
                best = p;
            }
        });

        if (best) {
            if (this.controlledPlayer) this.controlledPlayer.isControlled = false;
            this.controlledPlayer = best;
            best.isControlled = true;
        }
    }

    throwBall(thrower, targetX, targetY, intendedReceiver) {
        if (this.ballInAir) return;
        thrower.hasBall = false;
        this.ballCarrier = null;
        this.ball = new Football(thrower.x, thrower.y, targetX, targetY, BALL_SPEED);
        this.ballInAir = true;
        this.targetReceiver = intendedReceiver;
        this.audio.pass();
    }

    checkBallCatch() {
        if (!this.ball || !this.ball.active) return;

        const catchRadius = 25;

        // Check offense catching
        for (let i = 0; i < this.offensePlayers.length; i++) {
            const p = this.offensePlayers[i];
            if (!this.ball) break;
            if (p.tackled || p.isQB || p.hasBall) continue;
            if (dist(p.x, p.y, this.ball.x, this.ball.y) < catchRadius) {
                // Catch!
                p.hasBall = true;
                this.ballCarrier = p;
                this.ball.active = false;
                this.ball = null;
                this.ballInAir = false;
                this.audio.catch_();

                // If player on offense, give control to receiver
                if (this.possession === this.playerTeam) {
                    if (this.controlledPlayer) this.controlledPlayer.isControlled = false;
                    this.controlledPlayer = p;
                    p.isControlled = true;
                }
                break;
            }
        }

        if (!this.ball || !this.ball.active) return;

        // Check defense interception
        for (let i = 0; i < this.defensePlayers.length; i++) {
            const p = this.defensePlayers[i];
            if (!this.ball) break;
            if (p.tackled) continue;
            if (dist(p.x, p.y, this.ball.x, this.ball.y) < catchRadius * 0.7) {
                // Interception chance
                if (Math.random() < 0.18) {
                    p.hasBall = true;
                    this.ballCarrier = p;
                    this.ball.active = false;
                    this.ball = null;
                    this.ballInAir = false;
                    this.audio.interception();
                    this.flashText.show('INTERCEPTION!', 90, '#FF4500', 56);
                    this.screenShake.shake(8, 20);
                    this.particles.emit(p.x, p.y, 20, ['#FF4500', '#FFD700', '#FFF'], [2, 5], [20, 40], [3, 6]);

                    // Calculate yard for turnover
                    this.losYard = worldYToYard(p.y);
                    this.losYard = clamp(this.losYard, 1, 99);
                    this.state = STATE_TURNOVER;
                    this.stateTimer = 0;
                    break;
                }
            }
        }

        // Ball hit ground (passed target)
        if (this.ball && !this.ball.active) {
            this.ballInAir = false;
            this.flashText.show('INCOMPLETE', 60, '#FF6600', 44);
            this.audio.whistle();
            this.ball = null;
            // Next down, same LOS
            this.down++;
            if (this.down > 4) {
                // Turnover on downs
                this.flashText.show('TURNOVER ON DOWNS!', 90, '#FF0000', 48);
                this.possession = this.possession === 0 ? 1 : 0;
                this.down = 1;
                this.updateFirstDown();
            }
            this.state = STATE_PLAY_SELECT;
            this.stateTimer = 0;
            this.ai.reset();
        }
    }

    checkTackles() {
        if (!this.ballCarrier || this.ballCarrier.tackled) return;

        const defenders = this.possession === this.playerTeam ? this.defensePlayers : this.offensePlayers;
        // Actually: defenders are always the ones who tackle the ball carrier
        // Ball carrier is on offense, so defenders tackle them
        const tacklers = this.possession === 0 ? this.defensePlayers : this.offensePlayers;
        // Wait... let's think clearly:
        // If possession === 0, offense = team0 players (offensePlayers), defense = team1 players (defensePlayers)
        // ballCarrier is in offensePlayers (they're on offense)
        // defensePlayers tackle the ballCarrier
        // UNLESS it's an interception... but we handle that above
        // So: the opposite team from ballCarrier tackles

        // Determine who is on defense relative to ball carrier
        let tacklersArr;
        if (this.offensePlayers.includes(this.ballCarrier)) {
            tacklersArr = this.defensePlayers;
        } else {
            tacklersArr = this.offensePlayers;
        }

        tacklersArr.forEach(d => {
            if (d.tackled) return;
            const dd = dist(d.x, d.y, this.ballCarrier.x, this.ballCarrier.y);
            if (dd < TACKLE_DISTANCE) {
                this.performTackle(d, this.ballCarrier);
            }
        });
    }

    performTackle(tackler, ballCarrier) {
        ballCarrier.tackled = true;
        ballCarrier.tackleTimer = 0;
        this.audio.tackle();
        this.screenShake.shake(10, 15);
        this.particles.emit(ballCarrier.x, ballCarrier.y, 15, ['#FFF', '#FFD700', '#FF6600'], [2, 5], [15, 30], [2, 5]);

        // Push effect
        const pushAngle = angle(tackler.x, tackler.y, ballCarrier.x, ballCarrier.y);
        ballCarrier.vx = Math.cos(pushAngle) * 5;
        ballCarrier.vy = Math.sin(pushAngle) * 5;

        this.audio.whistle();
        this.state = STATE_TACKLE;
        this.stateTimer = 0;
    }

    checkOutOfBounds() {
        if (!this.ballCarrier || this.ballCarrier.tackled) return;

        if (this.ballCarrier.x <= FIELD_WORLD_LEFT + 5 || this.ballCarrier.x >= FIELD_WORLD_RIGHT - 5) {
            // Out of bounds
            this.ballCarrier.tackled = true;
            this.audio.whistle();
            this.flashText.show('OUT OF BOUNDS', 60, '#FFFFFF', 36);
            this.state = STATE_TACKLE;
            this.stateTimer = 0;
        }
    }

    checkTouchdown() {
        if (!this.ballCarrier || this.ballCarrier.tackled) return;

        const yard = worldYToYard(this.ballCarrier.y);

        // Team 0 scores at yard >= 100, Team 1 scores at yard <= 0
        // Use small threshold to catch edge cases
        let scored = false;
        if (this.possession === 0 && yard >= 99.5) {
            scored = true;
        } else if (this.possession === 1 && yard <= 0.5) {
            scored = true;
        }

        if (scored) {
            this.score[this.possession] += TOUCHDOWN_POINTS;
            this.audio.touchdown();
            this.flashText.show('TOUCHDOWN!!!', 120, '#FFD700', 72);
            this.screenShake.shake(15, 30);
            this.particles.emit(this.ballCarrier.x, this.ballCarrier.y, 50, ['#FFD700', '#FF6600', '#FF0000', '#FFF', '#00FF00'], [3, 8], [30, 60], [3, 8]);
            this.audio.crowd();
            this.state = STATE_SCORING;
            this.stateTimer = 0;
            this.clockRunning = false;
        }
    }

    endPlay() {
        // Calculate new LOS based on where ball carrier was downed
        if (this.ballCarrier) {
            const newYard = worldYToYard(this.ballCarrier.y);
            const yardsGained = this.possession === 0 ?
                (newYard - this.losYard) :
                (this.losYard - newYard);

            this.losYard = clamp(newYard, 1, 99);
            this.yardsToGo -= yardsGained;

            if (this.yardsToGo <= 0) {
                // First down!
                this.flashText.show('FIRST DOWN!', 70, '#00FF00', 48);
                this.audio.crowd();
                this.down = 1;
                this.updateFirstDown();
            } else {
                this.down++;
                if (this.down > 4) {
                    // Turnover on downs
                    this.flashText.show('TURNOVER ON DOWNS!', 90, '#FF0000', 48);
                    this.possession = this.possession === 0 ? 1 : 0;
                    this.down = 1;
                    this.updateFirstDown();
                }
            }
        }

        this.state = STATE_PLAY_SELECT;
        this.stateTimer = 0;
        this.ai.reset();
        this.clockRunning = false;
    }

    updateFirstDown() {
        this.yardsToGo = YARDS_FOR_FIRST_DOWN;
        if (this.possession === 0) {
            this.firstDownYard = this.losYard + YARDS_FOR_FIRST_DOWN;
            if (this.firstDownYard >= 100) this.firstDownYard = 100;
        } else {
            this.firstDownYard = this.losYard - YARDS_FOR_FIRST_DOWN;
            if (this.firstDownYard <= 0) this.firstDownYard = 0;
        }
    }

    endQuarter() {
        this.clockRunning = false;
        if (this.quarter === 2) {
            this.state = STATE_HALFTIME;
        } else if (this.quarter >= 4) {
            this.state = STATE_GAME_OVER;
        } else {
            this.state = STATE_QUARTER_END;
        }
        this.stateTimer = 0;
    }

    // =========================================================================
    // SETUP FUNCTIONS
    // =========================================================================

    setupKickoff(kickingTeam) {
        this.state = STATE_KICKOFF;
        this.stateTimer = 0;
        this.kickoffTimer = 0;
        this.clockRunning = false;
    }

    setupFormation() {
        this.offensePlayers = [];
        this.defensePlayers = [];
        this.ball = null;
        this.ballInAir = false;
        this.ballCarrier = null;

        const isPlayerOnOffense = this.possession === this.playerTeam;
        const offPlay = isPlayerOnOffense ? OFFENSIVE_PLAYS[this.offensePlayChoice] : OFFENSIVE_PLAYS[this.cpuPlayChoice];
        const defPlay = DEFENSIVE_PLAYS[this.defensePlayChoice];

        // Center of field X
        const centerX = (FIELD_WORLD_LEFT + FIELD_WORLD_RIGHT) / 2;
        const losY = this.losWorldY;

        // Attack direction multiplier for Y offsets
        // Team 0 attacks upward (toward higher yard numbers = lower Y)
        // Team 1 attacks downward (toward lower yard numbers = higher Y)
        const offDir = this.possession === 0 ? -1 : 1;
        this.attackDir = offDir;

        // Create offensive players
        offPlay.formation.forEach((pos, i) => {
            const px = centerX + pos.x;
            const py = losY + pos.y * (-offDir); // behind LOS goes opposite to attack dir
            const player = new Player(px, py, this.possession, pos.role, 10 + i);
            if (pos.role === 'QB') {
                player.isQB = true;
                player.speed = QB_SPEED;
            }
            if (pos.role === 'WR' || pos.role === 'RB') {
                player.speed = RECEIVER_SPEED;
            }
            this.offensePlayers.push(player);
        });

        // Give ball to QB
        const qb = this.offensePlayers.find(p => p.isQB);
        if (qb) {
            qb.hasBall = true;
            this.ballCarrier = qb;
        }

        // Assign routes
        // Routes use negative Y = "toward opponent endzone"
        // For team 0 (offDir=-1, attacks toward lower Y): dirMult=1 so route y is applied directly
        // For team 1 (offDir=1, attacks toward higher Y): dirMult=-1 so route y is flipped
        const routeDir = -offDir;
        offPlay.routes.forEach((route, i) => {
            if (route && this.offensePlayers[i]) {
                this.offensePlayers[i].setRoute(route, routeDir, centerX);
            }
        });

        // Create defensive players
        // Defense positions use same coordinate system as offense:
        // negative Y = toward the direction offense attacks (downfield)
        // positive Y = toward offense's own endzone
        defPlay.formation.forEach((pos, i) => {
            const px = centerX + pos.x;
            const py = losY + pos.y * (-offDir);
            const player = new Player(px, py, 1 - this.possession, pos.role, 50 + i);
            player.speed = DEFENDER_SPEED;
            this.defensePlayers.push(player);
        });

        // Set player control
        if (isPlayerOnOffense) {
            // Control QB
            this.controlledPlayer = qb;
            if (qb) qb.isControlled = true;
        } else {
            // Control nearest defender to ball
            const nearest = this.defensePlayers[4] || this.defensePlayers[0]; // LB or first
            this.controlledPlayer = nearest;
            if (nearest) nearest.isControlled = true;
        }

        // Camera
        this.targetCamX = centerX - GAME_WIDTH / 2;
        this.targetCamY = losY - GAME_HEIGHT / 2;
        this.camX = this.targetCamX;
        this.camY = this.targetCamY;
    }

    startPlay() {
        this.state = STATE_PLAYING;
        this.stateTimer = 0;
        this.playStarted = true;
        this.audio.snap();

        // For run plays, hand off immediately
        const isPlayerOnOffense = this.possession === this.playerTeam;
        const offPlay = isPlayerOnOffense ? OFFENSIVE_PLAYS[this.offensePlayChoice] : OFFENSIVE_PLAYS[this.cpuPlayChoice];

        if (offPlay.isRun && isPlayerOnOffense) {
            this.handoffTimer = 18;
            this.pendingHandoff = true;
        }

        this.clockRunning = true;
        this.ai.reset();
    }

    // =========================================================================
    // CAMERA
    // =========================================================================

    updateCamera() {
        let followX, followY;
        if (this.ball && this.ball.active) {
            followX = this.ball.x;
            followY = this.ball.y;
        } else if (this.ballCarrier) {
            followX = this.ballCarrier.x;
            followY = this.ballCarrier.y;
        } else if (this.controlledPlayer) {
            followX = this.controlledPlayer.x;
            followY = this.controlledPlayer.y;
        } else {
            followX = (FIELD_WORLD_LEFT + FIELD_WORLD_RIGHT) / 2;
            followY = this.losWorldY;
        }

        this.targetCamX = followX - GAME_WIDTH / 2;
        this.targetCamY = followY - GAME_HEIGHT / 2;

        this.camX = lerp(this.camX, this.targetCamX, CAMERA_SMOOTH);
        this.camY = lerp(this.camY, this.targetCamY, CAMERA_SMOOTH);
    }

    // =========================================================================
    // RENDERING
    // =========================================================================

    render() {
        const ctx = this.ctx;
        ctx.clearRect(0, 0, GAME_WIDTH, GAME_HEIGHT);

        switch (this.state) {
            case STATE_TITLE:
                this.ui.drawTitle(ctx, this.input);
                break;

            case STATE_TEAM_SELECT:
                // handled in update for input, but we still draw
                this.ui.drawTeamSelect(ctx, this.input, this.audio);
                break;

            case STATE_COIN_TOSS:
                this.ui.drawCoinToss(ctx, this.coinTossResult, this.coinTossTimer);
                break;

            case STATE_PLAY_SELECT:
                // Draw field behind
                this.renderField();
                this.ui.drawPlaySelect(ctx, this.possession === this.playerTeam, 
                    this.possession === this.playerTeam ? this.offensePlayChoice : this.defensePlayChoice,
                    this.input, this.audio);
                break;

            case STATE_FORMATION:
                this.renderField();
                this.renderPlayers();
                this.ui.drawHUD(ctx, this);
                // Show "PRESS SPACE TO SNAP" hint
                if (this.snapTimer > 20 && this.possession === this.playerTeam) {
                    ctx.font = 'bold 24px Arial';
                    ctx.textAlign = 'center';
                    ctx.fillStyle = Math.floor(this.stateTimer / 20) % 2 === 0 ? '#FFD700' : '#FFF';
                    ctx.fillText('PRESS SPACE TO SNAP', GAME_WIDTH / 2, GAME_HEIGHT - 60);
                }
                break;

            case STATE_PLAYING:
                this.renderField();
                this.renderPlayers();
                if (this.ball && this.ball.active) {
                    this.ball.draw(ctx, this.camX + this.screenShake.offsetX, this.camY + this.screenShake.offsetY);
                }
                // Show receiver targets when QB has ball (player on offense)
                if (this.possession === this.playerTeam && this.ballCarrier && this.ballCarrier.isQB && this.ballCarrier.hasBall) {
                    const receivers = this.offensePlayers.filter(p => !p.isQB && !p.tackled && p.role !== 'OL' && p.role !== 'C');
                    this.ui.drawReceiverTargets(ctx, receivers, this.camX + this.screenShake.offsetX, this.camY + this.screenShake.offsetY);
                }
                this.ui.drawHUD(ctx, this);
                break;

            case STATE_TACKLE:
            case STATE_TURNOVER:
                this.renderField();
                this.renderPlayers();
                this.ui.drawHUD(ctx, this);
                break;

            case STATE_SCORING:
            case STATE_EXTRA_POINT:
                this.renderField();
                this.renderPlayers();
                this.ui.drawHUD(ctx, this);
                break;

            case STATE_KICKOFF:
                this.renderField();
                this.ui.drawHUD(ctx, this);
                break;

            case STATE_HALFTIME:
                this.ui.drawHalftime(ctx);
                break;

            case STATE_QUARTER_END:
                this.ui.drawQuarterEnd(ctx, this.quarter);
                break;

            case STATE_GAME_OVER:
                this.ui.drawGameOver(ctx, this);
                break;

            case STATE_CONTROLS:
                this.ui.drawControls(ctx, this.input);
                break;
        }

        // Always draw flash text and particles on top
        this.flashText.draw(ctx);
        this.particles.draw(ctx, this.camX + this.screenShake.offsetX, this.camY + this.screenShake.offsetY);
    }

    renderField() {
        const shakeX = this.screenShake.offsetX;
        const shakeY = this.screenShake.offsetY;
        const firstDown = this.possession === 0 ? this.firstDownYard : this.firstDownYard;
        this.field.draw(this.ctx, this.camX + shakeX, this.camY + shakeY, this.losYard, firstDown, this.attackDir);
    }

    renderPlayers() {
        const shakeX = this.screenShake.offsetX;
        const shakeY = this.screenShake.offsetY;
        const camX = this.camX + shakeX;
        const camY = this.camY + shakeY;

        const team1Data = TEAMS[this.team1Index];
        const team2Data = TEAMS[this.team2Index];

        // Draw all players (offense then defense)
        const offTeamData = this.possession === 0 ? team1Data : team2Data;
        const defTeamData = this.possession === 0 ? team2Data : team1Data;

        this.offensePlayers.forEach(p => {
            const isControlled = p === this.controlledPlayer;
            p.draw(this.ctx, camX, camY, offTeamData, isControlled);
        });

        this.defensePlayers.forEach(p => {
            const isControlled = p === this.controlledPlayer;
            p.draw(this.ctx, camX, camY, defTeamData, isControlled);
        });
    }
}

// Start the game when page loads
window.addEventListener('load', () => {
    new Game();
});
