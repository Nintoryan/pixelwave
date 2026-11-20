'use strict';
// PixelWave v6 acoustic modem.
// 16 parallel channels, each 4-FSK (4 tones, 62.5 Hz apart) → 32 bits per 40 ms symbol.
// Tones: 1000 … 4937 Hz. Detection window 32 ms (bins 31.25 Hz) inside each 40 ms symbol.
// Frame: 2 sync symbols + 15 data symbols (60 bytes = RS(60,44) codeword, scrambled).
// User payload per frame: 42 bytes + CRC16. Frame time 0.68 s.
const Modem = (() => {
  const SR = 12000;          // internal receiver rate
  const HOP = 12;            // 1 ms at 12 kHz
  const N = 384;             // 32 ms DFT window → 31.25 Hz bins
  const SYM_MS = 40;         // symbol length in ms (= hops)
  const READ_MS = 37;        // window end, ms after symbol start (window covers 5..37 ms)
  const CH = 16, TONES = 4, BIN0 = 32, BIN_STEP = 2;
  const SYNC_SYMS = 2, DATA_SYMS = 15, FRAME_SYMS = SYNC_SYMS + DATA_SYMS;
  const CODE_BYTES = 60, NSYM = 16, DATA_BYTES = CODE_BYTES - NSYM, PAYLOAD = DATA_BYTES - 2;
  const FRAME_SEC = FRAME_SYMS * SYM_MS / 1000;
  const bin = (c, t) => BIN0 + BIN_STEP * (c * TONES + t);
  const freq = (c, t) => bin(c, t) * SR / N;
  const SYNC = [
    Array.from({ length: CH }, (_, c) => (3 * c) % 4),
    Array.from({ length: CH }, (_, c) => ((3 * c) % 4 + 2) % 4)
  ];
  // Fixed pseudo-random scrambler and tone phases (identical on both sides).
  function prng(seed) { let s = seed >>> 0; return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s; }; }
  const SCR = (() => { const r = prng(0x5eed1234); return Uint8Array.from({ length: CODE_BYTES }, () => r() & 255); })();
  const PHASE = (() => { const r = prng(0x0badf00d); return Float64Array.from({ length: CH * TONES }, () => (r() / 4294967296) * 2 * Math.PI); })();

  function crc16(a, n) {
    let c = 0xffff;
    for (let i = 0; i < n; i++) { c ^= a[i] << 8; for (let j = 0; j < 8; j++) c = (c & 0x8000) ? ((c << 1) ^ 0x1021) & 0xffff : (c << 1) & 0xffff; }
    return c;
  }

  // payload: Uint8Array(PAYLOAD) → array of FRAME_SYMS symbols, each an array of CH tone indices.
  function frameSymbols(payload) {
    const d = new Uint8Array(DATA_BYTES);
    d.set(payload.subarray(0, PAYLOAD));
    const c = crc16(d, PAYLOAD); d[PAYLOAD] = c & 255; d[PAYLOAD + 1] = c >> 8;
    const cw = RS.encode(d, NSYM);
    for (let i = 0; i < CODE_BYTES; i++) cw[i] ^= SCR[i];
    const syms = [SYNC[0], SYNC[1]];
    for (let s = 0; s < DATA_SYMS; s++) {
      const tones = new Array(CH);
      for (let j = 0; j < 4; j++) {
        const b = cw[s * 4 + j];
        for (let k = 0; k < 4; k++) tones[j * 4 + k] = (b >> (6 - 2 * k)) & 3;
      }
      syms.push(tones);
    }
    return syms;
  }

  // Synthesize symbols (array of tone arrays) at sample rate sr.
  const SIN = (() => { const t = new Float32Array(4097); for (let i = 0; i <= 4096; i++) t[i] = Math.sin(2 * Math.PI * i / 4096); return t; })();
  function synth(symList, sr) {
    const L = Math.round(sr * SYM_MS / 1000), R = Math.round(sr * 0.002);
    const out = new Float32Array(symList.length * L + R);
    const amp = 0.105;
    for (let s = 0; s < symList.length; s++) {
      const tones = symList[s], base = s * L;
      for (let c = 0; c < CH; c++) {
        const t = tones[c], inc = freq(c, t) / sr * 4096;
        let ph = PHASE[c * TONES + t] / (2 * Math.PI) * 4096 + inc * base; // continuous per-tone phase
        ph %= 4096;
        for (let i = 0; i < L + R; i++) {
          const env = i < R ? 0.5 - 0.5 * Math.cos(Math.PI * i / R) : i >= L ? 0.5 + 0.5 * Math.cos(Math.PI * (i - L) / R) : 1;
          const idx = ph | 0;
          out[base + i] += amp * env * (SIN[idx] + (SIN[idx + 1] - SIN[idx]) * (ph - idx));
          ph += inc; if (ph >= 4096) ph -= 4096;
        }
      }
    }
    for (let i = 0; i < out.length; i++) out[i] = 0.95 * Math.tanh(out[i] * 1.25);
    return out;
  }

  // Streaming resampler (windowed sinc, 32 taps, cutoff 5.3 kHz) to 12 kHz.
  class Resampler {
    constructor(sr) {
      this.sr = sr; this.ratio = sr / SR; this.buf = new Float32Array(0); this.t = 16;
      const taps = 32, P = 128, fc = Math.min(5300, sr * 0.45) / sr;
      this.P = P; this.table = new Float32Array((P + 1) * taps);
      for (let p = 0; p <= P; p++) {
        const frac = p / P; let sum = 0;
        for (let k = 0; k < taps; k++) {
          const d = k - 15 - frac, x = 2 * fc * d;
          const s = d === 0 ? 2 * fc : Math.sin(Math.PI * x) / (Math.PI * d);
          const w = 0.42 + 0.5 * Math.cos(Math.PI * d / 16) + 0.08 * Math.cos(2 * Math.PI * d / 16);
          const v = Math.abs(d) >= 16 ? 0 : s * w;
          this.table[p * taps + k] = v; sum += v;
        }
        for (let k = 0; k < taps; k++) this.table[p * taps + k] /= sum;
      }
    }
    process(input) {
      if (this.sr === SR) return Float32Array.from(input);
      const b = new Float32Array(this.buf.length + input.length); b.set(this.buf); b.set(input, this.buf.length);
      const out = [];
      let t = this.t;
      while (t + 17 < b.length) {
        const i0 = Math.floor(t), frac = t - i0, p = Math.round(frac * this.P), off = p * 32;
        let y = 0; const s = i0 - 15;
        for (let k = 0; k < 32; k++) y += b[s + k] * this.table[off + k];
        out.push(y); t += this.ratio;
      }
      const keep = Math.max(0, Math.floor(t) - 16);
      this.buf = b.slice(keep); this.t = t - keep;
      return Float32Array.from(out);
    }
  }

  // Receiver: resample → sliding DFT on 64 bins → spectrogram (1 ms hops) → frame sync → RS decode.
  const NB = CH * TONES, RING = 4096;
  class Receiver {
    constructor(onFrame, onStats) {
      this.onFrame = onFrame; this.onStats = onStats || (() => {});
      this.rs = null; this.sr = 0;
      this.x = new Float32Array(N); this.n = 0;
      this.re = new Float64Array(NB); this.im = new Float64Array(NB); this.m = new Int32Array(NB);
      this.k = Int32Array.from({ length: NB }, (_, i) => BIN0 + BIN_STEP * i);
      this.cos = Float64Array.from({ length: N }, (_, i) => Math.cos(2 * Math.PI * i / N));
      this.sin = Float64Array.from({ length: N }, (_, i) => Math.sin(2 * Math.PI * i / N));
      this.spec = new Float32Array(RING * NB); this.hops = 0; // number of hops recorded
      this.cursor = N / HOP + 2; this.good = 0; this.bad = 0; this.level = 0; this.lastScore = 0;
    }
    feed(samples, sr) {
      if (sr !== this.sr) { this.sr = sr; this.rs = new Resampler(sr); }
      const y = this.rs.process(samples);
      let e = 0;
      for (let i = 0; i < y.length; i++) {
        const v = y[i]; e += v * v;
        const old = this.x[this.n % N]; this.x[this.n % N] = v;
        const d = v - old;
        if (d !== 0) for (let j = 0; j < NB; j++) { const m = this.m[j]; this.re[j] += d * this.cos[m]; this.im[j] -= d * this.sin[m]; }
        for (let j = 0; j < NB; j++) { let m = this.m[j] + this.k[j]; if (m >= N) m -= N; this.m[j] = m; }
        this.n++;
        if (this.n % HOP === 0) {
          const o = (this.hops % RING) * NB;
          for (let j = 0; j < NB; j++) this.spec[o + j] = this.re[j] * this.re[j] + this.im[j] * this.im[j];
          this.hops++;
        }
      }
      if (y.length) this.level = 0.8 * this.level + 0.2 * Math.sqrt(e / y.length);
      this.process();
      if (this.n - (this.statN || 0) > SR / 4) { this.statN = this.n; this.onStats({ good: this.good, bad: this.bad, level: this.level }); }
    }
    E(h, j) { return this.spec[(h % RING) * NB + j]; }
    syncScore(t) {
      let s = 0;
      for (let q = 0; q < SYNC_SYMS; q++) {
        const h = t + q * SYM_MS + READ_MS;
        for (let c = 0; c < CH; c++) {
          let sum = 1e-12; for (let k = 0; k < TONES; k++) sum += this.E(h, c * TONES + k);
          s += this.E(h, c * TONES + SYNC[q][c]) / sum;
        }
      }
      return s / (SYNC_SYMS * CH);
    }
    process() {
      const TH = 0.62, span = FRAME_SYMS * SYM_MS;
      let guard = 0;
      while (guard++ < 5000) {
        const t = this.cursor;
        if (t < this.hops - RING + 50) { this.cursor = this.hops - RING + 50; continue; }
        if (t + SYNC_SYMS * SYM_MS + 30 + READ_MS >= this.hops) break;
        const sc = this.syncScore(t);
        this.lastScore = sc;
        if (sc < TH) { this.cursor++; continue; }
        // refine: look ahead 30 ms for the best plateau
        let best = sc, scores = [sc];
        for (let d = 1; d <= 30; d++) { const v = this.syncScore(t + d); scores.push(v); if (v > best) best = v; }
        let sw = 0, st = 0;
        for (let d = 0; d < scores.length; d++) if (scores[d] >= best - 0.04) { sw += scores[d]; st += scores[d] * d; }
        const t0 = t + Math.round(st / sw);
        if (t0 + span + 2 >= this.hops) break; // wait for the whole frame
        const res = this.decodeAt(t0);
        if (res) { this.good++; this.cursor = t0 + span - 12; this.onFrame(res.payload, res); }
        else { this.bad++; this.cursor = t + 4; }
        this.onStats({ good: this.good, bad: this.bad, level: this.level });
      }
    }
    decodeAt(t0) {
      for (const dt of [0, -1, 1, -2, 2]) {
        const r = this.tryDecode(t0 + dt);
        if (r) return r;
      }
      return null;
    }
    tryDecode(t0) {
      const cw = new Uint8Array(CODE_BYTES), conf = new Float64Array(CODE_BYTES);
      for (let s = 0; s < DATA_SYMS; s++) {
        const h = t0 + (SYNC_SYMS + s) * SYM_MS + READ_MS;
        for (let j = 0; j < 4; j++) {
          let b = 0, cmin = Infinity;
          for (let k = 0; k < 4; k++) {
            const c = j * 4 + k; let bi = 0, bv = -1, sv = 0;
            for (let t = 0; t < TONES; t++) { const v = this.E(h, c * TONES + t); if (v > bv) { sv = bv; bv = v; bi = t; } else if (v > sv) sv = v; }
            b = (b << 2) | bi; cmin = Math.min(cmin, bv / (Math.max(sv, 0) + 1e-12));
          }
          cw[s * 4 + j] = b ^ SCR[s * 4 + j]; conf[s * 4 + j] = cmin;
        }
      }
      const order = [...Array(CODE_BYTES).keys()].sort((a, b) => conf[a] - conf[b]);
      for (const ne of [0, 4, 8, 12, 16]) {
        const d = RS.decode(cw, NSYM, order.slice(0, ne));
        if (!d) continue;
        const c = crc16(d, PAYLOAD);
        if ((d[PAYLOAD] | d[PAYLOAD + 1] << 8) !== c) continue;
        return { payload: d.slice(0, PAYLOAD), erasures: ne, t: t0 };
      }
      return null;
    }
  }
  return { SR, PAYLOAD, FRAME_SEC, SYM_MS, frameSymbols, synth, Receiver, crc16, freq };
})();
