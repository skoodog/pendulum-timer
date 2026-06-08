// =============================================================================
// NFL BLITZ CLONE - FIELD RENDERING
// =============================================================================

const _DASH_LOS = [8, 6];
const _DASH_FIRST_DOWN = [10, 5];
const _DASH_NONE = [];

class FieldRenderer {
    constructor() {
        this.grassPattern = null;
    }

    draw(ctx, camX, camY, losYard, firstDownYard, playerDir) {
        // Background
        ctx.fillStyle = '#1a1a2e';
        ctx.fillRect(0, 0, GAME_WIDTH, GAME_HEIGHT);

        // Draw field (transform by camera)
        this.drawGrass(ctx, camX, camY);
        this.drawYardLines(ctx, camX, camY);
        this.drawHashMarks(ctx, camX, camY);
        this.drawEndZones(ctx, camX, camY);
        this.drawFieldNumbers(ctx, camX, camY);
        this.drawSidelines(ctx, camX, camY);

        // Line of scrimmage
        if (losYard !== null && losYard !== undefined) {
            this.drawLOS(ctx, camX, camY, losYard);
        }

        // First down line
        if (firstDownYard !== null && firstDownYard !== undefined) {
            this.drawFirstDownLine(ctx, camX, camY, firstDownYard);
        }
    }

    drawGrass(ctx, camX, camY) {
        const minYard = -ENDZONE_YARDS;
        const maxYard = TOTAL_YARDS + ENDZONE_YARDS;
        const flx = FIELD_WORLD_LEFT - camX;
        for (let yard = minYard; yard <= maxYard; yard += 5) {
            const wy = yardToWorldY(yard);
            const nextWy = yardToWorldY(yard + 5);
            const sy = Math.min(wy, nextWy) - camY;
            const sh = Math.abs(nextWy - wy);
            if (sy + sh < -10 || sy > GAME_HEIGHT + 10) continue;

            const stripe = Math.floor((yard + ENDZONE_YARDS) / 5);
            ctx.fillStyle = stripe % 2 === 0 ? '#2d8a4e' : '#35A05A';
            ctx.fillRect(flx, sy, FIELD_WORLD_WIDTH, sh);
        }
    }

    drawEndZones(ctx, camX, camY) {
        // Top endzone (yard 100-110): this is the endzone for the team at the top
        const topEzY = yardToWorldY(FIELD_YARDS + ENDZONE_YARDS) - camY;
        const topEzH = ENDZONE_YARDS * PIXELS_PER_YARD;
        ctx.fillStyle = 'rgba(0, 0, 180, 0.5)';
        ctx.fillRect(FIELD_WORLD_LEFT - camX, topEzY, FIELD_WORLD_WIDTH, topEzH);

        // Endzone text setup (used for both)
        ctx.fillStyle = 'rgba(255,255,255,0.4)';
        ctx.font = 'bold 28px Arial';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('END ZONE', (FIELD_WORLD_LEFT + FIELD_WORLD_WIDTH / 2) - camX, topEzY + topEzH / 2);

        // Bottom endzone (yard -10 to 0)
        const botEzY = yardToWorldY(0) - camY;
        const botEzH = ENDZONE_YARDS * PIXELS_PER_YARD;
        ctx.fillStyle = 'rgba(180, 0, 0, 0.5)';
        ctx.fillRect(FIELD_WORLD_LEFT - camX, botEzY, FIELD_WORLD_WIDTH, botEzH);

        ctx.fillStyle = 'rgba(255,255,255,0.4)';
        ctx.fillText('END ZONE', (FIELD_WORLD_LEFT + FIELD_WORLD_WIDTH / 2) - camX, botEzY + botEzH / 2);
    }

    drawYardLines(ctx, camX, camY) {
        ctx.strokeStyle = 'rgba(255,255,255,0.6)';
        ctx.lineWidth = 1;

        for (let yard = 0; yard <= 100; yard += 5) {
            const wy = yardToWorldY(yard);
            const sy = wy - camY;
            if (sy < -20 || sy > GAME_HEIGHT + 20) continue;

            ctx.lineWidth = (yard % 10 === 0) ? 2 : 1;
            ctx.strokeStyle = (yard % 10 === 0) ? 'rgba(255,255,255,0.7)' : 'rgba(255,255,255,0.35)';
            ctx.beginPath();
            ctx.moveTo(FIELD_WORLD_LEFT - camX, sy);
            ctx.lineTo(FIELD_WORLD_RIGHT - camX, sy);
            ctx.stroke();
        }

        // Goal lines (yard 0 and 100)
        [0, 100].forEach(yard => {
            const wy = yardToWorldY(yard);
            const sy = wy - camY;
            ctx.strokeStyle = '#FFFFFF';
            ctx.lineWidth = 3;
            ctx.beginPath();
            ctx.moveTo(FIELD_WORLD_LEFT - camX, sy);
            ctx.lineTo(FIELD_WORLD_RIGHT - camX, sy);
            ctx.stroke();
        });
    }

    drawHashMarks(ctx, camX, camY) {
        ctx.strokeStyle = 'rgba(255,255,255,0.4)';
        ctx.lineWidth = 1;
        const h1 = FIELD_WORLD_LEFT + FIELD_WORLD_WIDTH * 0.33 - camX;
        const h2 = FIELD_WORLD_LEFT + FIELD_WORLD_WIDTH * 0.67 - camX;

        // Batch left hashes
        ctx.beginPath();
        for (let yard = 1; yard < 100; yard++) {
            if (yard % 5 === 0) continue;
            const sy = yardToWorldY(yard) - camY;
            if (sy < -10 || sy > GAME_HEIGHT + 10) continue;
            ctx.moveTo(h1 - 4, sy);
            ctx.lineTo(h1 + 4, sy);
        }
        ctx.stroke();

        // Batch right hashes
        ctx.beginPath();
        for (let yard = 1; yard < 100; yard++) {
            if (yard % 5 === 0) continue;
            const sy = yardToWorldY(yard) - camY;
            if (sy < -10 || sy > GAME_HEIGHT + 10) continue;
            ctx.moveTo(h2 - 4, sy);
            ctx.lineTo(h2 + 4, sy);
        }
        ctx.stroke();
    }

    drawFieldNumbers(ctx, camX, camY) {
        ctx.fillStyle = 'rgba(255,255,255,0.35)';
        ctx.font = 'bold 22px Arial';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';

        for (let yard = 10; yard <= 90; yard += 10) {
            const num = yard <= 50 ? yard : 100 - yard;
            const wy = yardToWorldY(yard);
            const sy = wy - camY;
            if (sy < -30 || sy > GAME_HEIGHT + 30) continue;

            // Left side
            ctx.fillText(num, FIELD_WORLD_LEFT - camX + 30, sy);
            // Right side
            ctx.fillText(num, FIELD_WORLD_RIGHT - camX - 30, sy);
        }
    }

    drawSidelines(ctx, camX, camY) {
        // Sideline borders
        ctx.strokeStyle = '#FFFFFF';
        ctx.lineWidth = 3;

        const topY = yardToWorldY(TOTAL_YARDS) - camY;
        const botY = (yardToWorldY(0) + ENDZONE_YARDS * PIXELS_PER_YARD) - camY;

        // Left sideline
        ctx.beginPath();
        ctx.moveTo(FIELD_WORLD_LEFT - camX, topY);
        ctx.lineTo(FIELD_WORLD_LEFT - camX, botY);
        ctx.stroke();

        // Right sideline
        ctx.beginPath();
        ctx.moveTo(FIELD_WORLD_RIGHT - camX, topY);
        ctx.lineTo(FIELD_WORLD_RIGHT - camX, botY);
        ctx.stroke();

        // Out of bounds areas
        ctx.fillStyle = '#5a3d00';
        // Left
        ctx.fillRect(0, topY, FIELD_WORLD_LEFT - camX, botY - topY);
        // Right
        ctx.fillRect(FIELD_WORLD_RIGHT - camX, topY, GAME_WIDTH - (FIELD_WORLD_RIGHT - camX), botY - topY);
    }

    drawLOS(ctx, camX, camY, yard) {
        const sy = yardToWorldY(yard) - camY;
        ctx.strokeStyle = 'rgba(0, 100, 255, 0.8)';
        ctx.lineWidth = 3;
        ctx.setLineDash(_DASH_LOS);
        ctx.beginPath();
        ctx.moveTo(FIELD_WORLD_LEFT - camX, sy);
        ctx.lineTo(FIELD_WORLD_RIGHT - camX, sy);
        ctx.stroke();
        ctx.setLineDash(_DASH_NONE);
    }

    drawFirstDownLine(ctx, camX, camY, yard) {
        if (yard < 0 || yard > 100) return;
        const sy = yardToWorldY(yard) - camY;
        ctx.strokeStyle = 'rgba(255, 255, 0, 0.8)';
        ctx.lineWidth = 3;
        ctx.setLineDash(_DASH_FIRST_DOWN);
        ctx.beginPath();
        ctx.moveTo(FIELD_WORLD_LEFT - camX, sy);
        ctx.lineTo(FIELD_WORLD_RIGHT - camX, sy);
        ctx.stroke();
        ctx.setLineDash(_DASH_NONE);

        // First down marker
        ctx.fillStyle = '#FFD700';
        ctx.font = 'bold 10px Arial';
        ctx.textAlign = 'right';
        ctx.fillText('1ST', FIELD_WORLD_LEFT - camX - 5, sy + 4);
    }
}
