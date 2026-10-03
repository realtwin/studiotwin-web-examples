// Tiny WebAudio mixer for the StudioTwin-generated sound set.
export class Mixer {
  constructor(base) {
    this.base = base; this.ctx = null; this.buffers = {}; this.on = false; this.loops = {};
  }
  // Must be called synchronously inside a user gesture: creates + resumes the context and plays a
  // silent buffer, which is what iOS Safari / Android Chrome need to allow audio at all.
  unlock() {
    try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch (e) {}   // iOS: play even with the mute switch on
    if (!this.ctx) this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (this.ctx.state !== 'running') this.ctx.resume();
    const b = this.ctx.createBuffer(1, 1, 22050), s = this.ctx.createBufferSource(); s.buffer = b; s.connect(this.ctx.destination); s.start(0);
  }
  async init() {
    if (this.master) return;
    if (!this.ctx) this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    this.master = this.ctx.createGain(); this.master.gain.value = 0; this.master.connect(this.ctx.destination);
    const names = ['ambience', 'drone', 'motor', 'heron', 'reveal', 'squeak', 'creak', 'splash', 'wings'];
    await Promise.all(names.map(async (n) => {
      try {
        const r = await fetch(`${this.base}sfx/${n}.mp3`);
        const ab = await r.arrayBuffer();
        // callback form for older Safari
        this.buffers[n] = await new Promise((res, rej) => this.ctx.decodeAudioData(ab, res, rej));
      } catch (e) { console.warn('sfx', n, e); }
    }));
    this.loops.ambience = this._loop('ambience', 0.75);
    this.loops.drone = this._loop('drone', 0.55);
    this.loops.motor = this._loop('motor', 0.0);
  }
  _loop(name, vol) {
    const b = this.buffers[name]; if (!b) return null;
    const src = this.ctx.createBufferSource(); src.buffer = b; src.loop = true;
    const g = this.ctx.createGain(); g.gain.value = vol;
    src.connect(g).connect(this.master); src.start();
    return { src, g };
  }
  async setOn(v) {
    if (v) { this.unlock(); await this.init(); }
    if (!this.ctx) return;
    this.on = v;
    if (v && this.ctx.state === 'suspended') await this.ctx.resume();
    const t = this.ctx.currentTime;
    this.master.gain.cancelScheduledValues(t);
    this.master.gain.setTargetAtTime(v ? 0.9 : 0, t, 0.4);
  }
  motor(throttle, speed) {
    const m = this.loops.motor; if (!m) return;
    const t = this.ctx.currentTime;
    m.g.gain.setTargetAtTime(0.10 + Math.min(1, Math.abs(throttle) * 0.6 + speed * 0.05) * 0.45, t, 0.2);
    m.src.playbackRate.setTargetAtTime(0.8 + Math.min(0.6, Math.abs(throttle) * 0.35 + speed * 0.03), t, 0.3);
  }
  motorOff() { const m = this.loops.motor; if (m) m.g.gain.setTargetAtTime(0, this.ctx.currentTime, 0.5); }
  oneShot(name, vol = 1) {
    if (!this.on || !this.buffers[name]) return;
    const s = this.ctx.createBufferSource(); s.buffer = this.buffers[name];
    const g = this.ctx.createGain(); g.gain.value = vol; s.connect(g).connect(this.master); s.start();
  }
}
