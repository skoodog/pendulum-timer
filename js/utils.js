// =============================================================================
// NFL BLITZ CLONE - UTILITY FUNCTIONS
// =============================================================================

function dist(x1, y1, x2, y2) {
    const dx = x2 - x1;
    const dy = y2 - y1;
    return Math.sqrt(dx * dx + dy * dy);
}

function lerp(a, b, t) {
    return a + (b - a) * t;
}

function clamp(val, min, max) {
    return Math.max(min, Math.min(max, val));
}

function randInt(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

function randFloat(min, max) {
    return Math.random() * (max - min) + min;
}

function angle(x1, y1, x2, y2) {
    return Math.atan2(y2 - y1, x2 - x1);
}

function normalize(vx, vy) {
    const len = Math.sqrt(vx * vx + vy * vy);
    if (len === 0) return { x: 0, y: 0 };
    return { x: vx / len, y: vy / len };
}

// Convert yard line (0-100) to world Y position
// Yard 0 = bottom endzone (team 1's endzone when attacking up)
// Yard 100 = top endzone
function yardToWorldY(yard) {
    // yard 0 is at the bottom of the field, yard 100 at top
    // World Y: endzone at bottom is Y = TOTAL_FIELD_LENGTH - ENDZONE_YARDS * PPY
    // Actually let's define: yard 0 (own endzone back) = world Y large, yard 100 = world Y small
    // Bottom of field (high Y) = yard 0 for team attacking up
    return (TOTAL_YARDS - yard) * PIXELS_PER_YARD;
}

function worldYToYard(wy) {
    return TOTAL_YARDS - (wy / PIXELS_PER_YARD);
}

// Get yard line number for display (0-50-0)
function getYardLineNumber(yard) {
    if (yard <= 0 || yard >= 100) return '';
    if (yard <= 50) return yard;
    return 100 - yard;
}

function easeOutCubic(t) {
    return 1 - Math.pow(1 - t, 3);
}

function easeInOutQuad(t) {
    return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
}

// Simple particle system
class Particle {
    constructor(x, y, vx, vy, life, color, size) {
        this.x = x;
        this.y = y;
        this.vx = vx;
        this.vy = vy;
        this.life = life;
        this.maxLife = life;
        this.color = color;
        this.size = size;
    }

    update() {
        this.x += this.vx;
        this.y += this.vy;
        this.vx *= 0.97;
        this.vy *= 0.97;
        this.life--;
        return this.life > 0;
    }

    draw(ctx, camX, camY) {
        const alpha = this.life / this.maxLife;
        const screenX = this.x - camX;
        const screenY = this.y - camY;
        ctx.globalAlpha = alpha;
        ctx.fillStyle = this.color;
        ctx.beginPath();
        ctx.arc(screenX, screenY, this.size * alpha, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 1;
    }
}

class ParticleSystem {
    constructor() {
        this.particles = [];
    }

    emit(x, y, count, colors, speedRange, lifeRange, sizeRange) {
        for (let i = 0; i < count; i++) {
            const ang = Math.random() * Math.PI * 2;
            const spd = randFloat(speedRange[0], speedRange[1]);
            const life = randInt(lifeRange[0], lifeRange[1]);
            const size = randFloat(sizeRange[0], sizeRange[1]);
            const color = colors[randInt(0, colors.length - 1)];
            this.particles.push(new Particle(x, y, Math.cos(ang) * spd, Math.sin(ang) * spd, life, color, size));
        }
    }

    update() {
        this.particles = this.particles.filter(p => p.update());
    }

    draw(ctx, camX, camY) {
        this.particles.forEach(p => p.draw(ctx, camX, camY));
    }
}

// Screen shake
class ScreenShake {
    constructor() {
        this.intensity = 0;
        this.duration = 0;
        this.timer = 0;
        this.offsetX = 0;
        this.offsetY = 0;
    }

    shake(intensity, duration) {
        this.intensity = intensity;
        this.duration = duration;
        this.timer = duration;
    }

    update() {
        if (this.timer > 0) {
            this.timer--;
            const t = this.timer / this.duration;
            const mag = this.intensity * t;
            this.offsetX = (Math.random() - 0.5) * 2 * mag;
            this.offsetY = (Math.random() - 0.5) * 2 * mag;
        } else {
            this.offsetX = 0;
            this.offsetY = 0;
        }
    }
}

// Flash text overlay
class FlashText {
    constructor() {
        this.texts = [];
    }

    show(text, duration, color, size) {
        this.texts.push({
            text: text,
            duration: duration || 90,
            timer: 0,
            color: color || '#FFD700',
            size: size || 64
        });
    }

    update() {
        this.texts = this.texts.filter(t => {
            t.timer++;
            return t.timer < t.duration;
        });
    }

    draw(ctx) {
        this.texts.forEach(t => {
            const progress = t.timer / t.duration;
            let alpha, scale;
            if (progress < 0.15) {
                alpha = progress / 0.15;
                scale = 1.5 - 0.5 * (progress / 0.15);
            } else if (progress > 0.7) {
                alpha = 1 - (progress - 0.7) / 0.3;
                scale = 1;
            } else {
                alpha = 1;
                scale = 1;
            }
            ctx.save();
            ctx.globalAlpha = alpha;
            ctx.font = `bold ${Math.round(t.size * scale)}px "Arial Black", Arial, sans-serif`;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            // Shadow
            ctx.fillStyle = '#000';
            ctx.fillText(t.text, GAME_WIDTH / 2 + 3, GAME_HEIGHT / 2 + 3);
            // Outline
            ctx.strokeStyle = '#000';
            ctx.lineWidth = 4;
            ctx.strokeText(t.text, GAME_WIDTH / 2, GAME_HEIGHT / 2);
            // Fill
            ctx.fillStyle = t.color;
            ctx.fillText(t.text, GAME_WIDTH / 2, GAME_HEIGHT / 2);
            ctx.restore();
        });
    }
}
