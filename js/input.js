// =============================================================================
// NFL BLITZ CLONE - INPUT HANDLING
// =============================================================================

class InputManager {
    constructor() {
        this.keys = {};
        this.keysJustPressed = {};
        this.mouseX = 0;
        this.mouseY = 0;
        this.mouseClicked = false;
        this.mouseDown = false;

        window.addEventListener('keydown', (e) => {
            if (!this.keys[e.code]) {
                this.keysJustPressed[e.code] = true;
            }
            this.keys[e.code] = true;
            // Prevent scrolling with arrow keys/space
            if (['ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Space'].includes(e.code)) {
                e.preventDefault();
            }
        });

        window.addEventListener('keyup', (e) => {
            this.keys[e.code] = false;
        });

        window.addEventListener('mousemove', (e) => {
            const canvas = document.getElementById('gameCanvas');
            if (canvas) {
                const rect = canvas.getBoundingClientRect();
                const scaleX = GAME_WIDTH / rect.width;
                const scaleY = GAME_HEIGHT / rect.height;
                this.mouseX = (e.clientX - rect.left) * scaleX;
                this.mouseY = (e.clientY - rect.top) * scaleY;
            }
        });

        window.addEventListener('mousedown', (e) => {
            this.mouseDown = true;
            this.mouseClicked = true;
        });

        window.addEventListener('mouseup', (e) => {
            this.mouseDown = false;
        });
    }

    isDown(code) {
        return !!this.keys[code];
    }

    justPressed(code) {
        return !!this.keysJustPressed[code];
    }

    // Movement vector from WASD/Arrows
    getMoveVector() {
        let mx = 0, my = 0;
        if (this.isDown('ArrowLeft') || this.isDown('KeyA')) mx -= 1;
        if (this.isDown('ArrowRight') || this.isDown('KeyD')) mx += 1;
        if (this.isDown('ArrowUp') || this.isDown('KeyW')) my -= 1;
        if (this.isDown('ArrowDown') || this.isDown('KeyS')) my += 1;
        // Normalize diagonal
        if (mx !== 0 && my !== 0) {
            const inv = 1 / Math.SQRT2;
            mx *= inv;
            my *= inv;
        }
        return { x: mx, y: my };
    }

    isSprinting() {
        return this.isDown('ShiftLeft') || this.isDown('ShiftRight');
    }

    clearFrame() {
        this.keysJustPressed = {};
        this.mouseClicked = false;
    }
}
