// =============================================================================
// NFL BLITZ CLONE - CPU AI
// =============================================================================

class AIController {
    constructor() {
        this.playChoice = 0;
        this.decisionTimer = 0;
        this.passDecisionMade = false;
        this.targetReceiver = null;
        this.qbScrambleTimer = 0;
    }

    choosePlay(isOffense) {
        if (isOffense) {
            return randInt(0, OFFENSIVE_PLAYS.length - 1);
        } else {
            return randInt(0, DEFENSIVE_PLAYS.length - 1);
        }
    }

    updateOffense(players, opponents, ball, game) {
        // Find QB
        const qb = players.find(p => p.isQB && !p.tackled);
        if (!qb) return;

        if (qb.hasBall) {
            this.decisionTimer++;

            const play = OFFENSIVE_PLAYS[game.cpuPlayChoice];
            if (play && play.isRun) {
                // Hand off to RB
                const rb = players.find(p => p.role === 'RB' && !p.tackled);
                if (rb && this.decisionTimer > 15) {
                    qb.hasBall = false;
                    rb.hasBall = true;
                    game.ballCarrier = rb;
                    game.controlledPlayer = rb;
                    return;
                }
            }

            // Passing logic
            if (this.decisionTimer > 40 && !this.passDecisionMade) {
                this.passDecisionMade = true;
                // Find best receiver
                const receivers = players.filter(p => !p.isQB && p.role !== 'OL' && p.role !== 'C' && !p.tackled);
                let bestReceiver = null;
                let bestScore = -Infinity;

                receivers.forEach(r => {
                    // Score based on openness and distance
                    let minDefDist = Infinity;
                    opponents.forEach(d => {
                        const dd = dist(r.x, r.y, d.x, d.y);
                        if (dd < minDefDist) minDefDist = dd;
                    });
                    const score = minDefDist - dist(qb.x, qb.y, r.x, r.y) * 0.3;
                    if (score > bestScore) {
                        bestScore = score;
                        bestReceiver = r;
                    }
                });

                if (bestReceiver) {
                    this.targetReceiver = bestReceiver;
                }
            }

            // Throw after a small delay
            if (this.passDecisionMade && this.decisionTimer > 55 && this.targetReceiver) {
                // Lead the receiver
                const leadX = this.targetReceiver.x + this.targetReceiver.vx * 8;
                const leadY = this.targetReceiver.y + this.targetReceiver.vy * 8;
                game.throwBall(qb, leadX, leadY, this.targetReceiver);
                this.passDecisionMade = false;
                this.targetReceiver = null;
                return;
            }

            // QB scramble if taking too long
            if (this.decisionTimer > 80) {
                // Scramble
                qb.vx = (Math.random() - 0.5) * QB_SPEED;
                qb.vy = game.attackDir * QB_SPEED;
            }

            // Pocket movement - avoid rushers
            const nearestRusher = this.findNearest(qb, opponents);
            if (nearestRusher && dist(qb.x, qb.y, nearestRusher.x, nearestRusher.y) < 60) {
                const awayAngle = angle(nearestRusher.x, nearestRusher.y, qb.x, qb.y);
                qb.vx += Math.cos(awayAngle) * 1.5;
                qb.vy += Math.sin(awayAngle) * 1.5;
            }
        }

        // Non-QB players with ball (RB after handoff)
        const ballCarrier = players.find(p => p.hasBall && !p.isQB && !p.tackled);
        if (ballCarrier) {
            this.runWithBall(ballCarrier, opponents, game);
        }

        // Route runners
        players.forEach(p => {
            if (!p.hasBall && !p.tackled && p.route && !p.routeComplete) {
                p.runRoute();
            }
            // OL/C block nearest defender
            if ((p.role === 'OL' || p.role === 'C') && !p.tackled) {
                this.blockNearest(p, opponents);
            }
        });
    }

    updateDefense(defenders, offensePlayers, ball, game) {
        const ballCarrier = offensePlayers.find(p => p.hasBall && !p.tackled);
        const defPlay = DEFENSIVE_PLAYS[game.defensePlayChoice];

        defenders.forEach((d, i) => {
            if (d.tackled) return;
            if (d.isControlled) return; // player-controlled

            if (defPlay && defPlay.type === 'blitz') {
                // Blitz: everyone rushes
                if (d.role === 'DL' || d.role === 'LB') {
                    if (ballCarrier) {
                        d.moveToward(ballCarrier.x, ballCarrier.y, DEFENDER_SPEED * 1.05);
                    }
                    return;
                }
            }

            if (d.role === 'DL') {
                // Rush the QB or ball carrier
                if (ballCarrier) {
                    d.moveToward(ballCarrier.x, ballCarrier.y, DEFENDER_SPEED * 0.95);
                }
                return;
            }

            if (defPlay && defPlay.type === 'zone' && defPlay.zones && defPlay.zones[i]) {
                // Zone coverage: go to zone, then react to ball
                const zone = defPlay.zones[i];
                const zoneWorldX = (FIELD_WORLD_LEFT + FIELD_WORLD_RIGHT) / 2 + zone.x;
                const zoneWorldY = game.losWorldY + zone.y * (-game.attackDir);

                if (ball && ball.active) {
                    // React to ball in air
                    d.moveToward(ball.x, ball.y, DEFENDER_SPEED * 1.1);
                } else if (ballCarrier && !ballCarrier.isQB) {
                    // Chase ball carrier
                    d.moveToward(ballCarrier.x, ballCarrier.y, DEFENDER_SPEED);
                } else {
                    d.moveToward(zoneWorldX, zoneWorldY, DEFENDER_SPEED * 0.7);
                }
                return;
            }

            // Man coverage / default
            if (defPlay && defPlay.type === 'man') {
                // Cover nearest eligible receiver
                const receivers = offensePlayers.filter(p => !p.isQB && p.role !== 'OL' && p.role !== 'C' && !p.tackled);
                if (receivers.length > 0) {
                    // Assign each defender a receiver
                    const target = receivers[i % receivers.length];
                    if (ball && ball.active) {
                        d.moveToward(ball.x, ball.y, DEFENDER_SPEED * 1.1);
                    } else if (ballCarrier && !ballCarrier.isQB) {
                        d.moveToward(ballCarrier.x, ballCarrier.y, DEFENDER_SPEED);
                    } else {
                        d.moveToward(target.x, target.y, DEFENDER_SPEED * 0.9);
                    }
                    return;
                }
            }

            // Goal line / fallback: everyone chases ball carrier
            if (ballCarrier) {
                d.moveToward(ballCarrier.x, ballCarrier.y, DEFENDER_SPEED);
            }
        });
    }

    runWithBall(carrier, opponents, game) {
        // Try to run toward endzone while avoiding defenders
        let targetY = carrier.y + game.attackDir * 100; // toward opponent endzone
        let targetX = carrier.x;

        // Find nearest defenders and dodge
        let nearestDef = null;
        let nearestDist = Infinity;
        opponents.forEach(d => {
            if (d.tackled) return;
            const dd = dist(carrier.x, carrier.y, d.x, d.y);
            if (dd < nearestDist) {
                nearestDist = dd;
                nearestDef = d;
            }
        });

        if (nearestDef && nearestDist < 80) {
            // Dodge
            const dodgeAngle = angle(nearestDef.x, nearestDef.y, carrier.x, carrier.y);
            targetX = carrier.x + Math.cos(dodgeAngle) * 60;
            targetY = carrier.y + Math.sin(dodgeAngle) * 30 + game.attackDir * 40;
        }

        carrier.moveToward(targetX, targetY, PLAYER_SPEED);
    }

    blockNearest(blocker, opponents) {
        let nearest = this.findNearest(blocker, opponents);
        if (nearest && dist(blocker.x, blocker.y, nearest.x, nearest.y) < 80) {
            // Move between nearest opponent and where they want to go
            blocker.moveToward(nearest.x, nearest.y, PLAYER_SPEED * 0.7);
            // Push them back on collision
            if (dist(blocker.x, blocker.y, nearest.x, nearest.y) < TACKLE_DISTANCE) {
                const pushAngle = angle(blocker.x, blocker.y, nearest.x, nearest.y);
                nearest.vx += Math.cos(pushAngle) * 0.8;
                nearest.vy += Math.sin(pushAngle) * 0.8;
            }
        }
    }

    findNearest(player, others) {
        let nearest = null;
        let nearestDist = Infinity;
        others.forEach(o => {
            if (o.tackled) return;
            const d = dist(player.x, player.y, o.x, o.y);
            if (d < nearestDist) {
                nearestDist = d;
                nearest = o;
            }
        });
        return nearest;
    }

    reset() {
        this.decisionTimer = 0;
        this.passDecisionMade = false;
        this.targetReceiver = null;
        this.qbScrambleTimer = 0;
    }
}
