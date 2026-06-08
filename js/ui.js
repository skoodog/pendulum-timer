// =============================================================================
// NFL BLITZ CLONE - UI RENDERING
// =============================================================================

class UIRenderer {
    constructor() {
        this.titleFlash = 0;
        this.selectedTeam1 = 0;
        this.selectedTeam2 = 1;
        this.teamSelectSide = 0; // 0 = player picking, 1 = cpu assigned
        this.selectedPlay = 0;
    }

    drawTitle(ctx, input) {
        this.titleFlash++;

        // Background
        ctx.fillStyle = '#0a0a1a';
        ctx.fillRect(0, 0, GAME_WIDTH, GAME_HEIGHT);

        // Decorative field lines
        ctx.strokeStyle = 'rgba(45, 138, 78, 0.2)';
        ctx.lineWidth = 2;
        for (let i = 0; i < 20; i++) {
            const y = i * 40;
            ctx.beginPath();
            ctx.moveTo(0, y);
            ctx.lineTo(GAME_WIDTH, y);
            ctx.stroke();
        }

        // Title
        const bounce = Math.sin(this.titleFlash * 0.03) * 8;
        ctx.save();

        // Title shadow
        ctx.font = 'bold 96px "Arial Black", Arial, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillStyle = '#000';
        ctx.fillText('NFL BLITZ', GAME_WIDTH / 2 + 4, 220 + bounce + 4);

        // Title outline
        ctx.strokeStyle = '#FF6600';
        ctx.lineWidth = 6;
        ctx.strokeText('NFL BLITZ', GAME_WIDTH / 2, 220 + bounce);

        // Title fill gradient
        const grad = ctx.createLinearGradient(0, 160 + bounce, 0, 240 + bounce);
        grad.addColorStop(0, '#FFD700');
        grad.addColorStop(0.5, '#FF6600');
        grad.addColorStop(1, '#CC0000');
        ctx.fillStyle = grad;
        ctx.fillText('NFL BLITZ', GAME_WIDTH / 2, 220 + bounce);

        // Subtitle
        ctx.font = 'bold 28px Arial';
        ctx.fillStyle = '#00CED1';
        ctx.fillText('ARCADE EDITION', GAME_WIDTH / 2, 270 + bounce);

        // Press start (flashing)
        if (Math.floor(this.titleFlash / 30) % 2 === 0) {
            ctx.font = 'bold 36px Arial';
            ctx.fillStyle = '#FFD700';
            ctx.fillText('PRESS ENTER OR SPACE TO START', GAME_WIDTH / 2, 420);
        }

        // Controls info
        ctx.font = '18px Arial';
        ctx.fillStyle = '#888';
        ctx.fillText('WASD/Arrows = Move | Space = Action | Shift = Sprint', GAME_WIDTH / 2, 520);
        ctx.fillText('Click = Pass to Receiver | E = Switch Player', GAME_WIDTH / 2, 550);

        // Footer
        ctx.font = '14px Arial';
        ctx.fillStyle = '#555';
        ctx.fillText('A browser-based NFL Blitz tribute', GAME_WIDTH / 2, 650);

        ctx.restore();
    }

    drawTeamSelect(ctx, input, audio) {
        ctx.fillStyle = '#0a0a1a';
        ctx.fillRect(0, 0, GAME_WIDTH, GAME_HEIGHT);

        // Title
        ctx.font = 'bold 48px "Arial Black", Arial, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillStyle = '#FFD700';
        ctx.fillText('SELECT YOUR TEAM', GAME_WIDTH / 2, 70);

        // Draw team cards
        const cols = 4;
        const cardW = 240;
        const cardH = 120;
        const startX = (GAME_WIDTH - cols * (cardW + 20)) / 2 + cardW / 2;
        const startY = 140;

        TEAMS.forEach((team, i) => {
            const col = i % cols;
            const row = Math.floor(i / cols);
            const cx = startX + col * (cardW + 20);
            const cy = startY + row * (cardH + 20);

            const selected = i === this.selectedTeam1;

            // Card background
            ctx.fillStyle = selected ? team.primary : '#222';
            ctx.strokeStyle = selected ? '#FFD700' : '#444';
            ctx.lineWidth = selected ? 4 : 2;

            // Rounded rect
            this.roundRect(ctx, cx - cardW / 2, cy - cardH / 2, cardW, cardH, 10);
            ctx.fill();
            ctx.stroke();

            // Team color bar
            if (!selected) {
                ctx.fillStyle = team.primary;
                this.roundRect(ctx, cx - cardW / 2, cy - cardH / 2, cardW, 8, 10, true);
                ctx.fill();
            }

            // Team name
            ctx.font = `bold ${selected ? 26 : 22}px Arial`;
            ctx.fillStyle = selected ? team.secondary : '#AAA';
            ctx.textAlign = 'center';
            ctx.fillText(team.name, cx, cy + 5);

            // Team abbr
            ctx.font = 'bold 14px Arial';
            ctx.fillStyle = selected ? team.accent : '#666';
            ctx.fillText(team.abbr, cx, cy + 30);

            // Selection number
            ctx.font = 'bold 16px Arial';
            ctx.fillStyle = '#888';
            ctx.fillText(`${i + 1}`, cx, cy - 25);
        });

        // Instructions
        ctx.font = 'bold 22px Arial';
        ctx.fillStyle = '#CCC';
        ctx.textAlign = 'center';
        ctx.fillText('Use LEFT/RIGHT or A/D to select, ENTER/SPACE to confirm', GAME_WIDTH / 2, 470);

        // VS display
        ctx.font = 'bold 36px Arial';
        ctx.fillStyle = '#FFD700';
        ctx.fillText('VS', GAME_WIDTH / 2, 540);

        // Player team
        const pt = TEAMS[this.selectedTeam1];
        ctx.fillStyle = pt.primary;
        ctx.font = 'bold 30px Arial';
        ctx.textAlign = 'right';
        ctx.fillText(pt.name, GAME_WIDTH / 2 - 40, 545);

        // CPU team (random, shown after player picks)
        ctx.fillStyle = '#888';
        ctx.font = 'bold 30px Arial';
        ctx.textAlign = 'left';
        ctx.fillText('CPU', GAME_WIDTH / 2 + 40, 545);

        // Input is handled in game.js updateTeamSelect
    }

    drawPlaySelect(ctx, isOffense, selectedPlay, input, audio) {
        const plays = isOffense ? OFFENSIVE_PLAYS : DEFENSIVE_PLAYS;
        const title = isOffense ? 'CHOOSE YOUR PLAY - OFFENSE' : 'CHOOSE YOUR PLAY - DEFENSE';

        // Overlay
        ctx.fillStyle = 'rgba(0, 0, 0, 0.85)';
        ctx.fillRect(0, 0, GAME_WIDTH, GAME_HEIGHT);

        // Title
        ctx.font = 'bold 36px "Arial Black", Arial, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillStyle = isOffense ? '#FF6600' : '#00BFFF';
        ctx.fillText(title, GAME_WIDTH / 2, 80);

        // Play cards
        const cardW = 240;
        const cardH = 200;
        const totalW = plays.length * (cardW + 20);
        const startX = (GAME_WIDTH - totalW) / 2 + cardW / 2;

        plays.forEach((play, i) => {
            const cx = startX + i * (cardW + 20);
            const cy = GAME_HEIGHT / 2 - 20;
            const selected = i === selectedPlay;

            // Card
            ctx.fillStyle = selected ? (isOffense ? '#553300' : '#002255') : '#1a1a1a';
            ctx.strokeStyle = selected ? '#FFD700' : '#444';
            ctx.lineWidth = selected ? 4 : 2;
            this.roundRect(ctx, cx - cardW / 2, cy - cardH / 2, cardW, cardH, 12);
            ctx.fill();
            ctx.stroke();

            // Play name
            ctx.font = `bold ${selected ? 24 : 20}px Arial`;
            ctx.fillStyle = selected ? '#FFD700' : '#AAA';
            ctx.textAlign = 'center';
            ctx.fillText(play.name, cx, cy - 50);

            // Play icon/diagram
            ctx.font = 'bold 28px Arial';
            ctx.fillStyle = selected ? '#FFF' : '#666';
            ctx.fillText(play.icon || '?', cx, cy + 10);

            // Key hint
            ctx.font = 'bold 18px Arial';
            ctx.fillStyle = selected ? '#FFD700' : '#555';
            ctx.fillText(`[${i + 1}]`, cx, cy + 60);

            // Selection arrow
            if (selected) {
                ctx.fillStyle = '#FFD700';
                ctx.beginPath();
                ctx.moveTo(cx - 10, cy - cardH / 2 - 15);
                ctx.lineTo(cx + 10, cy - cardH / 2 - 15);
                ctx.lineTo(cx, cy - cardH / 2 - 5);
                ctx.fill();
            }
        });

        // Instructions
        ctx.font = '20px Arial';
        ctx.fillStyle = '#888';
        ctx.textAlign = 'center';
        ctx.fillText('LEFT/RIGHT to browse, ENTER/SPACE to select, or press 1-4', GAME_WIDTH / 2, GAME_HEIGHT - 80);

        return selectedPlay;
    }

    drawCoinToss(ctx, result, timer) {
        ctx.fillStyle = 'rgba(0, 0, 0, 0.9)';
        ctx.fillRect(0, 0, GAME_WIDTH, GAME_HEIGHT);

        ctx.font = 'bold 48px "Arial Black", Arial, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillStyle = '#FFD700';
        ctx.fillText('COIN TOSS', GAME_WIDTH / 2, 200);

        // Animated coin
        const coinPhase = Math.sin(timer * 0.1) * 30;
        ctx.fillStyle = '#FFD700';
        ctx.beginPath();
        ctx.ellipse(GAME_WIDTH / 2, 350, 40, Math.abs(coinPhase) + 5, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = '#B8860B';
        ctx.lineWidth = 3;
        ctx.stroke();

        if (timer > 60) {
            ctx.font = 'bold 36px Arial';
            ctx.fillStyle = result ? '#00FF00' : '#FF6600';
            ctx.fillText(result ? 'YOU RECEIVE!' : 'YOU KICK OFF!', GAME_WIDTH / 2, 460);
        }
    }

    drawHUD(ctx, game) {
        const barH = 50;
        // Top bar background
        ctx.fillStyle = 'rgba(0, 0, 0, 0.8)';
        ctx.fillRect(0, 0, GAME_WIDTH, barH);
        ctx.strokeStyle = '#FFD700';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(0, barH);
        ctx.lineTo(GAME_WIDTH, barH);
        ctx.stroke();

        const team1 = TEAMS[game.team1Index];
        const team2 = TEAMS[game.team2Index];

        // Team 1 name and score (left)
        ctx.font = 'bold 20px Arial';
        ctx.textAlign = 'left';
        ctx.fillStyle = team1.primary;
        ctx.fillText(team1.abbr, 15, 22);
        ctx.fillStyle = '#FFF';
        ctx.font = 'bold 28px Arial';
        ctx.fillText(game.score[0].toString(), 65, 24);

        // Team 2 name and score (right)
        ctx.font = 'bold 20px Arial';
        ctx.textAlign = 'right';
        ctx.fillStyle = team2.primary;
        ctx.fillText(team2.abbr, GAME_WIDTH - 15, 22);
        ctx.fillStyle = '#FFF';
        ctx.font = 'bold 28px Arial';
        ctx.fillText(game.score[1].toString(), GAME_WIDTH - 65, 24);

        // Quarter and time (center)
        ctx.textAlign = 'center';
        ctx.font = 'bold 14px Arial';
        ctx.fillStyle = '#FFD700';
        const qtrText = game.quarter <= 4 ? `Q${game.quarter}` : 'OT';
        ctx.fillText(qtrText, GAME_WIDTH / 2, 16);

        ctx.font = 'bold 22px Arial';
        ctx.fillStyle = '#FFF';
        const mins = Math.floor(game.gameTime / 60);
        const secs = Math.floor(game.gameTime % 60);
        ctx.fillText(`${mins}:${secs.toString().padStart(2, '0')}`, GAME_WIDTH / 2, 38);

        // Down and distance (bottom bar)
        const bottomY = barH + 2;
        ctx.fillStyle = 'rgba(0,0,0,0.6)';
        ctx.fillRect(0, barH, GAME_WIDTH, 24);

        ctx.font = 'bold 16px Arial';
        ctx.textAlign = 'center';

        const downNames = ['', '1st', '2nd', '3rd', '4th'];
        const downText = downNames[game.down] || '4th';
        let distText;
        if (game.yardsToGo <= 0) {
            distText = '& GOAL';
        } else {
            distText = `& ${Math.ceil(game.yardsToGo)}`;
        }

        const possTeam = game.possession === 0 ? team1 : team2;
        ctx.fillStyle = possTeam.primary;
        ctx.fillText(`${possTeam.abbr} Ball`, GAME_WIDTH / 2 - 200, bottomY + 16);

        ctx.fillStyle = '#FFD700';
        ctx.fillText(`${downText} ${distText}`, GAME_WIDTH / 2, bottomY + 16);

        const yardLine = Math.round(game.losYard);
        const displayYard = yardLine <= 50 ? yardLine : 100 - yardLine;
        // Yard 0-50 is team 0's side, 51-100 is team 1's side
        const side = yardLine <= 50 ? team1.abbr : team2.abbr;
        ctx.fillStyle = '#CCC';
        ctx.fillText(`Ball on ${side} ${displayYard}`, GAME_WIDTH / 2 + 200, bottomY + 16);

        // Control hint at bottom
        if (game.state === STATE_PLAYING) {
            ctx.font = '14px Arial';
            ctx.fillStyle = 'rgba(255,255,255,0.5)';
            ctx.textAlign = 'center';
            const hint = game.possession === game.playerTeam ?
                (game.ballInAir ? 'Wait for catch...' :
                 game.ballCarrier && game.ballCarrier.isQB ? 'CLICK receiver to pass | WASD move | SHIFT sprint' :
                 'WASD move | SHIFT sprint | E switch player') :
                'WASD move defender | SHIFT sprint | E switch player';
            ctx.fillText(hint, GAME_WIDTH / 2, GAME_HEIGHT - 15);
        }
    }

    drawHalftime(ctx) {
        ctx.fillStyle = 'rgba(0, 0, 0, 0.9)';
        ctx.fillRect(0, 0, GAME_WIDTH, GAME_HEIGHT);

        ctx.font = 'bold 72px "Arial Black", Arial, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillStyle = '#FFD700';
        ctx.fillText('HALFTIME', GAME_WIDTH / 2, GAME_HEIGHT / 2);
    }

    drawQuarterEnd(ctx, quarter) {
        ctx.fillStyle = 'rgba(0, 0, 0, 0.85)';
        ctx.fillRect(0, 0, GAME_WIDTH, GAME_HEIGHT);

        ctx.font = 'bold 56px "Arial Black", Arial, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillStyle = '#FFD700';
        ctx.fillText(`END OF Q${quarter}`, GAME_WIDTH / 2, GAME_HEIGHT / 2);
    }

    drawGameOver(ctx, game) {
        ctx.fillStyle = 'rgba(0, 0, 0, 0.92)';
        ctx.fillRect(0, 0, GAME_WIDTH, GAME_HEIGHT);

        const team1 = TEAMS[game.team1Index];
        const team2 = TEAMS[game.team2Index];

        ctx.font = 'bold 64px "Arial Black", Arial, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillStyle = '#FFD700';
        ctx.fillText('GAME OVER', GAME_WIDTH / 2, 180);

        // Final score
        ctx.font = 'bold 40px Arial';
        ctx.fillStyle = team1.primary;
        ctx.textAlign = 'right';
        ctx.fillText(team1.name, GAME_WIDTH / 2 - 30, 300);
        ctx.fillStyle = '#FFF';
        ctx.font = 'bold 64px Arial';
        ctx.fillText(game.score[0].toString(), GAME_WIDTH / 2 - 30, 380);

        ctx.font = 'bold 40px Arial';
        ctx.fillStyle = team2.primary;
        ctx.textAlign = 'left';
        ctx.fillText(team2.name, GAME_WIDTH / 2 + 30, 300);
        ctx.fillStyle = '#FFF';
        ctx.font = 'bold 64px Arial';
        ctx.fillText(game.score[1].toString(), GAME_WIDTH / 2 + 30, 380);

        ctx.font = 'bold 36px Arial';
        ctx.textAlign = 'center';
        ctx.fillStyle = '#FFD700';
        ctx.fillText('VS', GAME_WIDTH / 2, 305);

        // Winner
        let winner;
        if (game.score[0] > game.score[1]) {
            winner = team1.name + ' WIN!';
        } else if (game.score[1] > game.score[0]) {
            winner = team2.name + ' WIN!';
        } else {
            winner = 'TIE GAME!';
        }
        ctx.font = 'bold 48px Arial';
        ctx.fillStyle = '#00FF00';
        ctx.fillText(winner, GAME_WIDTH / 2, 470);

        // Restart
        if (Math.floor(Date.now() / 500) % 2 === 0) {
            ctx.font = 'bold 24px Arial';
            ctx.fillStyle = '#CCC';
            ctx.fillText('PRESS ENTER TO PLAY AGAIN', GAME_WIDTH / 2, 570);
        }
    }

    drawReceiverTargets(ctx, receivers, camX, camY) {
        receivers.forEach((r, i) => {
            if (r.tackled) return;
            const sx = r.x - camX;
            const sy = r.y - camY;

            // Target circle
            ctx.strokeStyle = '#FFD700';
            ctx.lineWidth = 2;
            ctx.setLineDash([5, 3]);
            ctx.beginPath();
            ctx.arc(sx, sy, PLAYER_RADIUS + 10, 0, Math.PI * 2);
            ctx.stroke();
            ctx.setLineDash([]);

            // Number hint
            ctx.fillStyle = '#FFD700';
            ctx.font = 'bold 14px Arial';
            ctx.textAlign = 'center';
            ctx.fillText(`${i + 1}`, sx, sy - PLAYER_RADIUS - 14);
        });
    }

    roundRect(ctx, x, y, w, h, r, topOnly) {
        ctx.beginPath();
        if (topOnly) {
            ctx.moveTo(x + r, y);
            ctx.lineTo(x + w - r, y);
            ctx.arcTo(x + w, y, x + w, y + r, r);
            ctx.lineTo(x + w, y + h);
            ctx.lineTo(x, y + h);
            ctx.lineTo(x, y + r);
            ctx.arcTo(x, y, x + r, y, r);
        } else {
            ctx.moveTo(x + r, y);
            ctx.lineTo(x + w - r, y);
            ctx.arcTo(x + w, y, x + w, y + r, r);
            ctx.lineTo(x + w, y + h - r);
            ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
            ctx.lineTo(x + r, y + h);
            ctx.arcTo(x, y + h, x, y + h - r, r);
            ctx.lineTo(x, y + r);
            ctx.arcTo(x, y, x + r, y, r);
        }
        ctx.closePath();
    }
}
