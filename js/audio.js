// =============================================================================
// NFL BLITZ CLONE - AUDIO (Web Audio API)
// =============================================================================

class AudioManager {
    constructor() {
        this.ctx = null;
        this.enabled = true;
        this.initialized = false;
    }

    init() {
        if (this.initialized) return;
        try {
            this.ctx = new (window.AudioContext || window.webkitAudioContext)();
            this.initialized = true;
        } catch (e) {
            this.enabled = false;
        }
    }

    playTone(freq, duration, type, volume) {
        if (!this.enabled || !this.ctx) return;
        if (this.ctx.state === 'suspended') this.ctx.resume();
        const osc = this.ctx.createOscillator();
        const gain = this.ctx.createGain();
        osc.type = type || 'square';
        osc.frequency.value = freq;
        gain.gain.value = volume || 0.1;
        gain.gain.exponentialRampToValueAtTime(0.001, this.ctx.currentTime + duration);
        osc.connect(gain);
        gain.connect(this.ctx.destination);
        osc.start();
        osc.stop(this.ctx.currentTime + duration);
    }

    playNoise(duration, volume) {
        if (!this.enabled || !this.ctx) return;
        if (this.ctx.state === 'suspended') this.ctx.resume();
        const bufferSize = this.ctx.sampleRate * duration;
        const buffer = this.ctx.createBuffer(1, bufferSize, this.ctx.sampleRate);
        const data = buffer.getChannelData(0);
        for (let i = 0; i < bufferSize; i++) {
            data[i] = (Math.random() * 2 - 1) * 0.5;
        }
        const source = this.ctx.createBufferSource();
        source.buffer = buffer;
        const gain = this.ctx.createGain();
        gain.gain.value = volume || 0.05;
        gain.gain.exponentialRampToValueAtTime(0.001, this.ctx.currentTime + duration);
        source.connect(gain);
        gain.connect(this.ctx.destination);
        source.start();
    }

    whistle() {
        this.playTone(880, 0.3, 'sine', 0.12);
        setTimeout(() => this.playTone(880, 0.5, 'sine', 0.1), 100);
    }

    tackle() {
        this.playNoise(0.15, 0.15);
        this.playTone(100, 0.2, 'sawtooth', 0.08);
    }

    snap() {
        this.playTone(200, 0.08, 'square', 0.06);
    }

    pass() {
        this.playTone(600, 0.1, 'sine', 0.06);
        setTimeout(() => this.playTone(800, 0.1, 'sine', 0.05), 50);
    }

    catch_() {
        this.playTone(500, 0.08, 'square', 0.06);
        this.playTone(700, 0.08, 'square', 0.05);
    }

    touchdown() {
        const notes = [523, 659, 784, 1047];
        notes.forEach((n, i) => {
            setTimeout(() => this.playTone(n, 0.3, 'square', 0.1), i * 150);
        });
        this.playNoise(1.0, 0.08);
    }

    interception() {
        this.playTone(400, 0.2, 'sawtooth', 0.1);
        setTimeout(() => this.playTone(300, 0.3, 'sawtooth', 0.1), 150);
    }

    select() {
        this.playTone(440, 0.08, 'square', 0.06);
    }

    confirm() {
        this.playTone(523, 0.08, 'square', 0.07);
        setTimeout(() => this.playTone(659, 0.08, 'square', 0.07), 80);
    }

    crowd() {
        this.playNoise(2.0, 0.03);
    }

    fieldGoal() {
        this.playTone(440, 0.2, 'sine', 0.08);
        setTimeout(() => this.playTone(554, 0.2, 'sine', 0.08), 200);
        setTimeout(() => this.playTone(659, 0.4, 'sine', 0.1), 400);
    }
}
