// =============================================================================
// NFL BLITZ CLONE - INPUT HANDLING (Remappable + Gamepad Support)
// =============================================================================

const DEFAULT_KEY_BINDINGS = {
    move_up:    ['KeyW', 'ArrowUp'],
    move_down:  ['KeyS', 'ArrowDown'],
    move_left:  ['KeyA', 'ArrowLeft'],
    move_right: ['KeyD', 'ArrowRight'],
    confirm:    ['Space', 'Enter'],
    sprint:     ['ShiftLeft', 'ShiftRight'],
    switch_player: ['KeyE'],
    pass_1:     ['Digit1'],
    pass_2:     ['Digit2'],
    pass_3:     ['Digit3'],
    pass_4:     ['Digit4'],
};

// Xbox controller mapping (Standard Gamepad layout)
// Buttons: 0=A, 1=B, 2=X, 3=Y, 4=LB, 5=RB, 6=LT, 7=RT, 8=Back, 9=Start,
//          10=LS click, 11=RS click, 12=DPad Up, 13=DPad Down, 14=DPad Left, 15=DPad Right
// Axes: 0=Left Stick X, 1=Left Stick Y, 2=Right Stick X, 3=Right Stick Y
const DEFAULT_GAMEPAD_BINDINGS = {
    move_up:        [12],         // DPad Up (menu navigation)
    move_down:      [13],         // DPad Down (menu navigation)
    move_left:      [14],         // DPad Left (menu navigation)
    move_right:     [15],         // DPad Right (menu navigation)
    confirm:        [0, 9],       // A, Start
    sprint:         [5, 7],       // RB, RT
    switch_player:  [1],          // B
    pass_1:         [12],         // DPad Up — pass to receiver 1 (during play)
    pass_2:         [15],         // DPad Right — pass to receiver 2
    pass_3:         [13],         // DPad Down — pass to receiver 3
    pass_4:         [14],         // DPad Left — pass to receiver 4
    pass_click:     [3],          // Y — smart pass to most open receiver
};

const GAMEPAD_STICK_DEADZONE = 0.25;

const ACTION_NAMES = {
    move_up: 'Move Up',
    move_down: 'Move Down',
    move_left: 'Move Left',
    move_right: 'Move Right',
    confirm: 'Confirm / Snap',
    sprint: 'Sprint',
    switch_player: 'Switch Player',
    pass_1: 'Pass 1',
    pass_2: 'Pass 2',
    pass_3: 'Pass 3',
    pass_4: 'Pass 4',
};

class InputManager {
    constructor() {
        this.keys = {};
        this.keysJustPressed = {};
        this.mouseX = 0;
        this.mouseY = 0;
        this.mouseClicked = false;
        this.mouseDown = false;

        // Remappable bindings
        this.keyBindings = {};
        this.gamepadBindings = {};
        this.loadBindings();

        // Gamepad state
        this.gamepadIndex = -1;
        this.gamepadButtons = {};
        this.gamepadButtonsJustPressed = {};
        this.gamepadAxes = [0, 0, 0, 0];
        this.gamepadConnected = false;
        this.gamepadPassClick = false;

        // Rebinding state
        this.rebinding = false;
        this.rebindAction = null;
        this.rebindCallback = null;
        this.rebindSource = null; // 'keyboard' or 'gamepad'

        window.addEventListener('keydown', (e) => {
            if (!this.keys[e.code]) {
                this.keysJustPressed[e.code] = true;
            }
            this.keys[e.code] = true;
            if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].includes(e.code)) {
                e.preventDefault();
            }

            if (this.rebinding && this.rebindSource === 'keyboard') {
                this._completeKeyRebind(e.code);
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

        window.addEventListener('mousedown', () => {
            this.mouseDown = true;
            this.mouseClicked = true;
        });

        window.addEventListener('mouseup', () => {
            this.mouseDown = false;
        });

        window.addEventListener('gamepadconnected', (e) => {
            this.gamepadIndex = e.gamepad.index;
            this.gamepadConnected = true;
        });

        window.addEventListener('gamepaddisconnected', (e) => {
            if (e.gamepad.index === this.gamepadIndex) {
                this.gamepadConnected = false;
                this.gamepadIndex = -1;
            }
        });
    }

    // =========================================================================
    // BINDING MANAGEMENT
    // =========================================================================

    loadBindings() {
        try {
            const savedKeys = localStorage.getItem('blitz_key_bindings');
            this.keyBindings = savedKeys ? JSON.parse(savedKeys) : this._cloneBindings(DEFAULT_KEY_BINDINGS);
        } catch {
            this.keyBindings = this._cloneBindings(DEFAULT_KEY_BINDINGS);
        }
        try {
            const savedPad = localStorage.getItem('blitz_gamepad_bindings');
            this.gamepadBindings = savedPad ? JSON.parse(savedPad) : this._cloneBindings(DEFAULT_GAMEPAD_BINDINGS);
        } catch {
            this.gamepadBindings = this._cloneBindings(DEFAULT_GAMEPAD_BINDINGS);
        }
    }

    saveBindings() {
        try {
            localStorage.setItem('blitz_key_bindings', JSON.stringify(this.keyBindings));
            localStorage.setItem('blitz_gamepad_bindings', JSON.stringify(this.gamepadBindings));
        } catch { /* localStorage unavailable */ }
    }

    resetBindings() {
        this.keyBindings = this._cloneBindings(DEFAULT_KEY_BINDINGS);
        this.gamepadBindings = this._cloneBindings(DEFAULT_GAMEPAD_BINDINGS);
        this.saveBindings();
    }

    _cloneBindings(bindings) {
        const clone = {};
        for (const key in bindings) {
            clone[key] = bindings[key].slice();
        }
        return clone;
    }

    remapKey(action, newCode) {
        if (!this.keyBindings[action]) return;
        this.keyBindings[action] = [newCode];
        this.saveBindings();
    }

    remapGamepadButton(action, buttonIndex) {
        if (!this.gamepadBindings[action]) return;
        this.gamepadBindings[action] = [buttonIndex];
        this.saveBindings();
    }

    startRebind(action, source, callback) {
        this.rebinding = true;
        this.rebindAction = action;
        this.rebindSource = source;
        this.rebindCallback = callback;
    }

    _completeKeyRebind(code) {
        if (code === 'Escape') {
            this.rebinding = false;
            this.rebindAction = null;
            if (this.rebindCallback) this.rebindCallback(null);
            this.rebindCallback = null;
            return;
        }
        this.remapKey(this.rebindAction, code);
        this.rebinding = false;
        if (this.rebindCallback) this.rebindCallback(code);
        this.rebindAction = null;
        this.rebindCallback = null;
    }

    // =========================================================================
    // RAW KEY ACCESS (legacy, still used by some code paths)
    // =========================================================================

    isDown(code) {
        return !!this.keys[code];
    }

    justPressed(code) {
        return !!this.keysJustPressed[code];
    }

    // =========================================================================
    // ACTION-BASED INPUT (checks both keyboard bindings + gamepad)
    // =========================================================================

    actionHeld(action) {
        const keys = this.keyBindings[action];
        if (keys) {
            for (let i = 0; i < keys.length; i++) {
                if (this.keys[keys[i]]) return true;
            }
        }
        const buttons = this.gamepadBindings[action];
        if (buttons) {
            for (let i = 0; i < buttons.length; i++) {
                if (this.gamepadButtons[buttons[i]]) return true;
            }
        }
        return false;
    }

    actionJustPressed(action) {
        const keys = this.keyBindings[action];
        if (keys) {
            for (let i = 0; i < keys.length; i++) {
                if (this.keysJustPressed[keys[i]]) return true;
            }
        }
        const buttons = this.gamepadBindings[action];
        if (buttons) {
            for (let i = 0; i < buttons.length; i++) {
                if (this.gamepadButtonsJustPressed[buttons[i]]) return true;
            }
        }
        return false;
    }

    // =========================================================================
    // GAMEPAD POLLING
    // =========================================================================

    pollGamepad() {
        const gamepads = navigator.getGamepads ? navigator.getGamepads() : [];
        let gp = null;

        if (this.gamepadIndex >= 0 && gamepads[this.gamepadIndex]) {
            gp = gamepads[this.gamepadIndex];
        } else {
            for (let i = 0; i < gamepads.length; i++) {
                if (gamepads[i]) {
                    gp = gamepads[i];
                    this.gamepadIndex = i;
                    this.gamepadConnected = true;
                    break;
                }
            }
        }

        if (!gp) {
            this.gamepadConnected = false;
            return;
        }

        this.gamepadConnected = true;
        const prevButtons = { ...this.gamepadButtons };
        this.gamepadButtonsJustPressed = {};

        for (let i = 0; i < gp.buttons.length; i++) {
            const pressed = gp.buttons[i].pressed;
            this.gamepadButtons[i] = pressed;
            if (pressed && !prevButtons[i]) {
                this.gamepadButtonsJustPressed[i] = true;

                if (this.rebinding && this.rebindSource === 'gamepad') {
                    this.remapGamepadButton(this.rebindAction, i);
                    this.rebinding = false;
                    if (this.rebindCallback) this.rebindCallback(i);
                    this.rebindAction = null;
                    this.rebindCallback = null;
                }
            }
        }

        this.gamepadAxes = [
            gp.axes[0] || 0,
            gp.axes[1] || 0,
            gp.axes[2] || 0,
            gp.axes[3] || 0,
        ];

        // Gamepad "pass click" via X button
        const passClickButtons = this.gamepadBindings.pass_click || [];
        this.gamepadPassClick = false;
        for (let i = 0; i < passClickButtons.length; i++) {
            if (this.gamepadButtonsJustPressed[passClickButtons[i]]) {
                this.gamepadPassClick = true;
                break;
            }
        }
    }

    // =========================================================================
    // UNIFIED MOVEMENT & SPRINT
    // =========================================================================

    getMoveVector() {
        let mx = 0, my = 0;

        // Keyboard only for movement (not gamepad buttons — stick handles that)
        const keys = this.keyBindings;
        if (keys.move_left) { for (const k of keys.move_left) { if (this.keys[k]) { mx -= 1; break; } } }
        if (keys.move_right) { for (const k of keys.move_right) { if (this.keys[k]) { mx += 1; break; } } }
        if (keys.move_up) { for (const k of keys.move_up) { if (this.keys[k]) { my -= 1; break; } } }
        if (keys.move_down) { for (const k of keys.move_down) { if (this.keys[k]) { my += 1; break; } } }

        // Gamepad left stick
        if (this.gamepadConnected) {
            const lx = this.gamepadAxes[0];
            const ly = this.gamepadAxes[1];
            if (Math.abs(lx) > GAMEPAD_STICK_DEADZONE) mx += lx;
            if (Math.abs(ly) > GAMEPAD_STICK_DEADZONE) my += ly;
        }

        // Clamp and normalize
        const len = Math.sqrt(mx * mx + my * my);
        if (len > 1) {
            mx /= len;
            my /= len;
        }
        return { x: mx, y: my };
    }

    isSprinting() {
        return this.actionHeld('sprint');
    }

    // =========================================================================
    // FRAME MANAGEMENT
    // =========================================================================

    clearFrame() {
        this.keysJustPressed = {};
        this.mouseClicked = false;
        this.gamepadPassClick = false;
    }

    // =========================================================================
    // DISPLAY HELPERS
    // =========================================================================

    getKeyName(code) {
        const names = {
            'Space': 'SPACE', 'Enter': 'ENTER', 'ShiftLeft': 'L-SHIFT', 'ShiftRight': 'R-SHIFT',
            'KeyA': 'A', 'KeyB': 'B', 'KeyC': 'C', 'KeyD': 'D', 'KeyE': 'E', 'KeyF': 'F',
            'KeyG': 'G', 'KeyH': 'H', 'KeyI': 'I', 'KeyJ': 'J', 'KeyK': 'K', 'KeyL': 'L',
            'KeyM': 'M', 'KeyN': 'N', 'KeyO': 'O', 'KeyP': 'P', 'KeyQ': 'Q', 'KeyR': 'R',
            'KeyS': 'S', 'KeyT': 'T', 'KeyU': 'U', 'KeyV': 'V', 'KeyW': 'W', 'KeyX': 'X',
            'KeyY': 'Y', 'KeyZ': 'Z',
            'Digit1': '1', 'Digit2': '2', 'Digit3': '3', 'Digit4': '4', 'Digit5': '5',
            'Digit6': '6', 'Digit7': '7', 'Digit8': '8', 'Digit9': '9', 'Digit0': '0',
            'ArrowUp': 'UP', 'ArrowDown': 'DOWN', 'ArrowLeft': 'LEFT', 'ArrowRight': 'RIGHT',
            'ControlLeft': 'L-CTRL', 'ControlRight': 'R-CTRL', 'AltLeft': 'L-ALT', 'AltRight': 'R-ALT',
            'Tab': 'TAB', 'Backspace': 'BKSP', 'CapsLock': 'CAPS',
        };
        return names[code] || code;
    }

    getButtonName(index) {
        const names = {
            0: 'A', 1: 'B', 2: 'X', 3: 'Y', 4: 'LB', 5: 'RB', 6: 'LT', 7: 'RT',
            8: 'Back', 9: 'Start', 10: 'LS', 11: 'RS',
            12: 'D-Up', 13: 'D-Down', 14: 'D-Left', 15: 'D-Right',
        };
        return names[index] || `Btn${index}`;
    }

    getBindingDisplay(action, source) {
        if (source === 'keyboard') {
            const keys = this.keyBindings[action] || [];
            return keys.map(k => this.getKeyName(k)).join(' / ') || 'None';
        } else {
            const buttons = this.gamepadBindings[action] || [];
            return buttons.map(b => this.getButtonName(b)).join(' / ') || 'None';
        }
    }
}
