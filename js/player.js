// =============================================================================
// NFL BLITZ CLONE - PLAYER CLASS
// =============================================================================

class Player {
    constructor(x, y, team, role, number) {
        this.x = x;
        this.y = y;
        this.vx = 0;
        this.vy = 0;
        this.team = team; // 0 or 1
        this.role = role; // QB, WR, RB, etc.
        this.number = number;
        this.radius = PLAYER_RADIUS;
        this.speed = PLAYER_SPEED;
        this.hasBall = false;
        this.isQB = role === 'QB';
        this.isControlled = false;
        this.targetX = null;
        this.targetY = null;
        this.route = null;
        this.routeIndex = 0;
        this.routeComplete = false;
        this.tackled = false;
        this.tackleTimer = 0;
        this.flashTimer = 0;
        this.speedTrail = [];
        this.blocked = false;
        this.blockTarget = null;
        // Defense properties
        this.coverTarget = null;
        this.zoneX = null;
        this.zoneY = null;
        this.isBlitzing = false;
        this.isRushing = false;
    }

    setRoute(route, dirMult, centerX) {
        if (!route) {
            this.route = null;
            return;
        }
        this.route = route.map(p => ({
            x: centerX + p.x,
            y: this.y + p.y * dirMult
        }));
        this.routeIndex = 0;
        this.routeComplete = false;
    }

    runRoute() {
        if (!this.route || this.routeIndex >= this.route.length) {
            this.routeComplete = true;
            // Drift forward a little after route
            return;
        }
        const target = this.route[this.routeIndex];
        const d = dist(this.x, this.y, target.x, target.y);
        if (d < 10) {
            this.routeIndex++;
            return;
        }
        const a = angle(this.x, this.y, target.x, target.y);
        this.vx = Math.cos(a) * this.speed;
        this.vy = Math.sin(a) * this.speed;
    }

    moveToward(tx, ty, spd) {
        const d = dist(this.x, this.y, tx, ty);
        if (d < 5) return;
        const a = angle(this.x, this.y, tx, ty);
        const s = spd || this.speed;
        this.vx = Math.cos(a) * s;
        this.vy = Math.sin(a) * s;
    }

    update() {
        if (this.tackled) {
            this.tackleTimer++;
            this.vx *= 0.8;
            this.vy *= 0.8;
            return;
        }

        this.x += this.vx;
        this.y += this.vy;
        this.vx *= FRICTION;
        this.vy *= FRICTION;

        // Keep on field (world bounds) - allow entry into endzones
        // World Y: yard 110 = Y 100 (top endzone back), yard -10 = Y 1300 (bottom endzone back)
        this.x = clamp(this.x, FIELD_WORLD_LEFT + this.radius, FIELD_WORLD_RIGHT - this.radius);
        this.y = clamp(this.y, 50, 1350);

        // Speed trail
        const speed = Math.sqrt(this.vx * this.vx + this.vy * this.vy);
        if (speed > 2) {
            this.speedTrail.push({ x: this.x, y: this.y, alpha: 0.5 });
        }
        this.speedTrail = this.speedTrail.filter(t => {
            t.alpha -= 0.05;
            return t.alpha > 0;
        });

        if (this.flashTimer > 0) this.flashTimer--;
    }

    draw(ctx, camX, camY, teamData, isUserControlled) {
        const sx = this.x - camX;
        const sy = this.y - camY;

        // Speed trails
        this.speedTrail.forEach(t => {
            const tx = t.x - camX;
            const ty = t.y - camY;
            ctx.globalAlpha = t.alpha * 0.3;
            ctx.fillStyle = teamData.primary;
            ctx.beginPath();
            ctx.arc(tx, ty, this.radius * 0.6, 0, Math.PI * 2);
            ctx.fill();
        });
        ctx.globalAlpha = 1;

        // Shadow
        ctx.fillStyle = 'rgba(0,0,0,0.3)';
        ctx.beginPath();
        ctx.ellipse(sx + 2, sy + 3, this.radius, this.radius * 0.6, 0, 0, Math.PI * 2);
        ctx.fill();

        // Body circle
        let bodyColor = teamData.primary;
        if (this.flashTimer > 0 && this.flashTimer % 4 < 2) {
            bodyColor = '#FFFFFF';
        }
        ctx.fillStyle = bodyColor;
        ctx.beginPath();
        ctx.arc(sx, sy, this.radius, 0, Math.PI * 2);
        ctx.fill();

        // Outline
        ctx.strokeStyle = this.tackled ? '#FF0000' : (isUserControlled ? '#FFD700' : teamData.secondary);
        ctx.lineWidth = isUserControlled ? 3 : 2;
        ctx.beginPath();
        ctx.arc(sx, sy, this.radius, 0, Math.PI * 2);
        ctx.stroke();

        // User control indicator ring
        if (isUserControlled && !this.tackled) {
            ctx.strokeStyle = '#FFD700';
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.arc(sx, sy, this.radius + 5, 0, Math.PI * 2);
            ctx.stroke();
        }

        // Jersey number
        ctx.fillStyle = teamData.secondary;
        ctx.font = 'bold 10px Arial';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(this.number, sx, sy);

        // Ball indicator
        if (this.hasBall) {
            ctx.fillStyle = '#8B4513';
            ctx.beginPath();
            ctx.ellipse(sx + 10, sy - 8, 6, 4, -0.3, 0, Math.PI * 2);
            ctx.fill();
            ctx.strokeStyle = '#FFFFFF';
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(sx + 8, sy - 9);
            ctx.lineTo(sx + 12, sy - 7);
            ctx.stroke();
        }

        // Role label (if QB)
        if (this.isQB && this.hasBall) {
            ctx.fillStyle = '#FFD700';
            ctx.font = 'bold 9px Arial';
            ctx.fillText('QB', sx, sy - this.radius - 6);
        }
    }
}

// Ball projectile (when thrown)
class Football {
    constructor(x, y, targetX, targetY, speed) {
        this.x = x;
        this.y = y;
        this.startX = x;
        this.startY = y;
        this.targetX = targetX;
        this.targetY = targetY;
        this.speed = speed || BALL_SPEED;
        const a = angle(x, y, targetX, targetY);
        this.vx = Math.cos(a) * this.speed;
        this.vy = Math.sin(a) * this.speed;
        this.totalDist = dist(x, y, targetX, targetY);
        this.active = true;
        this.rotation = a;
        this.catchable = true; // can be caught by receivers
        this.interceptable = true; // can be intercepted by defenders
    }

    update() {
        this.x += this.vx;
        this.y += this.vy;
        // Check if past target
        const traveled = dist(this.startX, this.startY, this.x, this.y);
        if (traveled >= this.totalDist) {
            this.active = false;
        }
        if (this.x < FIELD_WORLD_LEFT || this.x > FIELD_WORLD_RIGHT ||
            this.y < 0 || this.y > TOTAL_FIELD_LENGTH + ENDZONE_YARDS * PIXELS_PER_YARD) {
            this.active = false;
        }
    }

    draw(ctx, camX, camY) {
        const sx = this.x - camX;
        const sy = this.y - camY;
        ctx.save();
        ctx.translate(sx, sy);
        ctx.rotate(this.rotation);
        // Football shape
        ctx.fillStyle = '#8B4513';
        ctx.beginPath();
        ctx.ellipse(0, 0, 8, 5, 0, 0, Math.PI * 2);
        ctx.fill();
        // Laces
        ctx.strokeStyle = '#FFFFFF';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(-3, -1);
        ctx.lineTo(3, -1);
        ctx.stroke();
        // Spiral effect
        ctx.strokeStyle = 'rgba(255,255,255,0.3)';
        ctx.beginPath();
        ctx.arc(0, 0, 10, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
    }
}
