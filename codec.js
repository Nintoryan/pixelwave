'use strict';
// PixelWave streaming image codec.
// Image = grid of 8×8 "units" in raster order: Y 8×8 DCT + Cb/Cr 4×4 DCT (4:2:0).
// One continuous Exp-Golomb bitstream is cut into fixed chunks (one per radio frame).
// Each chunk tells where its first unit starts, and DC prediction restarts there,
// so every received chunk can be drawn immediately and a lost chunk only costs its own units.
const Codec = (() => {
  const TABLES = '3332334567998|133345678aaaa|223468acfff4579aceffff579bdefffff68acdffffff79bdfffffff7acefffffff8acefffffff8bdefffffff9ceffffffff9ceffffffffacfffffffffadfffffffffbefffffffffbefffffffffcffffffffffcffffffffff69aefffffff7acffffffff7bfffffffff7beffffffff8cfffffffff8cfffffffff8dfffffffff8ceffffffff9dfffffffff9bfffffffff9dfffffffff9efffffffff9efffffffffaffffffffffaffffffffffbffffffffff8a|3458adfffff579beffffff69befffffff8acefffffff9bdefffffffbefffffffffcffffffffffeffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff468cfffffff48befffffff6aeffffffff6adffffffff7beffffffff8bfffffffff9efffffffffaffffffffffcffffffffffeffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff1f';
  const CHUNK = 34, CHUNK_BITS = CHUNK * 8, NONE = 0xfff;
  const QUALITY = [6, 9, 12, 16, 20, 25, 30, 35, 40, 45, 50, 57, 64, 72, 80, 88];
  const LUMA = [16,11,10,16,24,40,51,61,12,12,14,19,26,58,60,55,14,13,16,24,40,57,69,56,14,17,22,29,51,87,80,62,18,22,37,56,68,109,103,77,24,35,55,64,81,104,113,92,49,64,78,87,103,121,120,101,72,92,95,98,112,100,103,99];
  const CHROMA4 = [17,18,24,47,18,21,26,66,24,26,56,99,47,66,99,99];
  function zigzag(n) {
    const out = [];
    for (let s = 0; s < 2 * n - 1; s++) for (let i = 0; i < n; i++) { const j = s - i; if (j < 0 || j >= n) continue; out.push(s % 2 ? i * n + j : j * n + i); }
    return out;
  }
  const ZZ8 = zigzag(8), ZZ4 = zigzag(4);
  function cosTable(n) { const t = new Float64Array(n * n); for (let u = 0; u < n; u++) for (let x = 0; x < n; x++) t[u * n + x] = (u ? Math.sqrt(2 / n) : Math.sqrt(1 / n)) * Math.cos((2 * x + 1) * u * Math.PI / (2 * n)); return t; }
  const C8 = cosTable(8), C4 = cosTable(4);
  function dct(block, n, C, inverse) {
    const tmp = new Float64Array(n * n), out = new Float64Array(n * n);
    for (let y = 0; y < n; y++) for (let u = 0; u < n; u++) { let s = 0; for (let x = 0; x < n; x++) s += inverse ? C[x * n + u] * block[y * n + x] : C[u * n + x] * block[y * n + x]; tmp[y * n + u] = s; }
    for (let u = 0; u < n; u++) for (let v = 0; v < n; v++) { let s = 0; for (let y = 0; y < n; y++) s += inverse ? C[y * n + v] * tmp[y * n + u] : C[v * n + y] * tmp[y * n + u]; out[v * n + u] = s; }
    return out;
  }
  function tables(q) {
    const Q = QUALITY[q], sc = Q < 50 ? 5000 / Q : 200 - 2 * Q;
    const y = LUMA.map(v => Math.max(1, Math.round((v * sc + 50) / 100)));
    const c = CHROMA4.map(v => Math.max(1, Math.round((v * sc * 0.6 + 50) / 100)));
    return { y, c };
  }
  const meta = (q, wu, hu) => (q & 15) | ((wu & 63) << 4) | ((hu & 63) << 10);
  const unmeta = m => ({ q: m & 15, wu: (m >> 4) & 63, hu: (m >> 10) & 63 });

  // ---- entropy coding: trained canonical Huffman tables ----
  // DC: category (bit length of |diff|) 0..12 + extra bits.
  // AC events: (last, run<16, cat 1..11) + extra bits + sign; NOAC = block without AC; ESC = raw.
  const AC_SYMS = 354, NOAC = 352, ESC = 353, DC_SYMS = 13;
  const acSym = (last, run, cat) => last * 176 + run * 11 + cat - 1;
  const cat = v => v ? 32 - Math.clz32(Math.abs(v)) : 0;
    function canonical(lengths) {
    const order = [...lengths.keys()].filter(i => lengths[i]).sort((a, b) => lengths[a] - lengths[b] || a - b);
    const codes = new Int32Array(lengths.length), first = [], count = new Int32Array(17), syms = [];
    let code = 0, len = 0;
    for (const s of order) { while (len < lengths[s]) { code <<= 1; len++; } codes[s] = code++; }
    for (const s of order) count[lengths[s]]++;
    // decoding tables
    let c = 0, idx = 0; const firstCode = new Int32Array(17), firstIdx = new Int32Array(17);
    for (let l = 1; l <= 16; l++) { c <<= 1; firstCode[l] = c; firstIdx[l] = idx; c += count[l]; idx += count[l]; }
    return { lengths, codes, order, count, firstCode, firstIdx };
  }
  let T_DC, T_AC;
  function setTables(str) {
    if (str.indexOf('|') < 0) str = ['4'.repeat(DC_SYMS), '4'.repeat(DC_SYMS), '9'.repeat(AC_SYMS), '9'.repeat(AC_SYMS)].join('|');
    const parts = str.split('|').map(p => Array.from(p, ch => parseInt(ch, 36)));
    T_DC = [canonical(parts[0]), canonical(parts[1])];
    T_AC = [canonical(parts[2]), canonical(parts[3])];
  }
  class Writer {
    constructor(counter) { this.bytes = []; this.bits = 0; this.counter = counter; }
    bit(b) { const i = this.bits >> 3; if (i >= this.bytes.length) this.bytes.push(0); if (b) this.bytes[i] |= 0x80 >> (this.bits & 7); this.bits++; }
    raw(v, n) { for (let i = n - 1; i >= 0; i--) this.bit((v >> i) & 1); }
    sym(tables, cls, s, kind) {
      if (this.counter) { this.counter[kind][cls][s]++; this.bits += 4; return; }
      const t = tables[cls]; this.raw(t.codes[s], t.lengths[s]);
    }
  }
  function encodeBlock(w, coefs, zz, dcPrev, cls) {
    const d = coefs[0] - dcPrev, dc = cat(d);
    w.sym(T_DC, cls, dc, 0);
    if (dc) w.raw(d > 0 ? d : d + (1 << dc) - 1, dc);
    let last = 0;
    for (let i = zz.length - 1; i > 0; i--) if (coefs[zz[i]]) { last = i; break; }
    if (!last) { w.sym(T_AC, cls, NOAC, 1); return; }
    let run = 0;
    for (let i = 1; i <= last; i++) {
      const v = coefs[zz[i]];
      if (!v) { run++; continue; }
      const c = Math.min(11, cat(v)), m = Math.min(Math.abs(v), 2047), isLast = i === last ? 1 : 0;
      if (run < 16) w.sym(T_AC, cls, acSym(isLast, run, c), 1);
      else { w.sym(T_AC, cls, ESC, 1); w.bit(isLast); w.raw(run, 6); w.raw(c, 4); }
      w.raw(m & ((1 << (c - 1)) - 1), c - 1); w.bit(v < 0 ? 1 : 0);
      run = 0;
    }
  }
  // rgba: Uint8ClampedArray of size (wu*8)×(hu*8)×4. Returns {meta, chunks:[{first, off, bytes}], bits}.
  function encode(rgba, wu, hu, q, counter) {
    const W = wu * 8, T = tables(q), w = new Writer(counter);
    const units = wu * hu, firsts = [];
    let dc = [0, 0, 0], prevChunk = -1; const stats = [0, 0];
    for (let u = 0; u < units; u++) {
      const ux = (u % wu) * 8, uy = Math.floor(u / wu) * 8;
      const chunk = Math.floor(w.bits / CHUNK_BITS);
      if (chunk !== prevChunk) { dc = [0, 0, 0]; firsts[chunk] = { first: u, off: w.bits % CHUNK_BITS }; prevChunk = chunk; }
      const Y = new Float64Array(64), Cb = new Float64Array(16), Cr = new Float64Array(16);
      for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
        const p = ((uy + y) * W + ux + x) * 4, r = rgba[p], g = rgba[p + 1], b = rgba[p + 2];
        Y[y * 8 + x] = 0.299 * r + 0.587 * g + 0.114 * b - 128;
        const ci = (y >> 1) * 4 + (x >> 1);
        Cb[ci] += (-0.168736 * r - 0.331264 * g + 0.5 * b) / 4;
        Cr[ci] += (0.5 * r - 0.418688 * g - 0.081312 * b) / 4;
      }
      const blocks = [[dct(Y, 8, C8), T.y, ZZ8], [dct(Cb, 4, C4), T.c, ZZ4], [dct(Cr, 4, C4), T.c, ZZ4]];
      blocks.forEach(([co, qt, zz], k) => {
        const qc = new Int32Array(co.length);
        for (let i = 0; i < co.length; i++) qc[i] = Math.round(co[i] / qt[i]);
        const b0 = w.bits; encodeBlock(w, qc, zz, dc[k], k ? 1 : 0); stats[k ? 1 : 0] += w.bits - b0; dc[k] = qc[0];
      });
    }
    const n = Math.max(1, Math.ceil(w.bits / CHUNK_BITS)), chunks = [];
    for (let c = 0; c < n; c++) {
      const bytes = new Uint8Array(CHUNK);
      for (let i = 0; i < CHUNK; i++) bytes[i] = w.bytes[c * CHUNK + i] || 0;
      const f = firsts[c] || { first: NONE, off: 0 };
      chunks.push({ first: f.first, off: f.off, bytes });
    }
    return { meta: meta(q, wu, hu), chunks, bits: w.bits, stats };
  }

  // Streaming decoder. addChunk() → re-decodes affected runs; draw into this.rgba.
  class Decoder {
    constructor(m) {
      const { q, wu, hu } = unmeta(m);
      this.meta = m; this.q = q; this.wu = wu; this.hu = hu; this.W = wu * 8; this.H = hu * 8;
      this.units = wu * hu; this.T = tables(q); this.chunks = new Map();
      this.done = new Uint8Array(this.units); this.count = 0;
      this.rgba = new Uint8ClampedArray(this.W * this.H * 4);
      for (let i = 3; i < this.rgba.length; i += 4) this.rgba[i] = 0;
    }
    addChunk(seq, first, off, bytes) {
      if (this.chunks.has(seq)) return false;
      this.chunks.set(seq, { first, off, bytes });
      let changed = this.run(seq);
      // a run that started in an earlier chunk may now be able to continue
      for (let s = seq - 1; s >= 0 && s >= seq - 64; s--) {
        const c = this.chunks.get(s); if (!c) break;
        if (c.first !== NONE) { changed = this.run(s) || changed; break; }
      }
      return changed;
    }
    run(seq) {
      const c = this.chunks.get(seq);
      if (!c || c.first === NONE || c.first >= this.units) return false;
      const self = this;
      let pos = seq * CHUNK_BITS + c.off, changed = false;
      const bit = () => { const ch = self.chunks.get(Math.floor(pos / CHUNK_BITS)); if (!ch) throw 0; const i = pos % CHUNK_BITS; pos++; return (ch.bytes[i >> 3] >> (7 - (i & 7))) & 1; };
      const raw = n => { let v = 0; for (let i = 0; i < n; i++) v = (v << 1) | bit(); return v; };
      const sym = t => { let code = 0; for (let l = 1; l <= 16; l++) { code = (code << 1) | bit(); const k = code - t.firstCode[l]; if (k < t.count[l]) return t.order[t.firstIdx[l] + k]; } throw 1; };
      const block = (n, zz, prev, cls) => {
        const out = new Int32Array(n * n);
        const dcat = sym(T_DC[cls]);
        let d = 0; if (dcat) { d = raw(dcat); if (d < 1 << (dcat - 1)) d -= (1 << dcat) - 1; }
        out[0] = prev + d;
        let i = 1;
        for (;;) {
          const s = sym(T_AC[cls]);
          if (s === NOAC) { if (i !== 1) throw 2; break; }
          let isLast, run, c;
          if (s === ESC) { isLast = bit(); run = raw(6); c = raw(4); if (!c || c > 11) throw 2; }
          else { isLast = (s / 176) | 0; run = ((s % 176) / 11) | 0; c = s % 11 + 1; }
          i += run; if (i >= n * n) throw 2;
          const m = (1 << (c - 1)) | raw(c - 1);
          out[zz[i]] = bit() ? -m : m; i++;
          if (isLast) break;
          if (i >= n * n) throw 2;
        }
        return out;
      };
      let u = c.first, dc = [0, 0, 0];
      try {
        while (u < this.units) {
          if (u !== c.first && Math.floor(pos / CHUNK_BITS) !== seq) break; // next chunk handles it
          const y = block(8, ZZ8, dc[0], 0); dc[0] = y[0];
          const cb = block(4, ZZ4, dc[1], 1); dc[1] = cb[0];
          const cr = block(4, ZZ4, dc[2], 1); dc[2] = cr[0];
          if (!this.done[u]) { this.draw(u, y, cb, cr); this.done[u] = 1; this.count++; changed = true; }
          u++;
        }
      } catch (e) { /* bits not available yet or corrupt */ }
      return changed;
    }
    draw(u, yq, cbq, crq) {
      const T = this.T;
      const Y = dct(Float64Array.from(yq, (v, i) => v * T.y[i]), 8, C8, true);
      const Cb = dct(Float64Array.from(cbq, (v, i) => v * T.c[i]), 4, C4, true);
      const Cr = dct(Float64Array.from(crq, (v, i) => v * T.c[i]), 4, C4, true);
      const ux = (u % this.wu) * 8, uy = Math.floor(u / this.wu) * 8;
      for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
        // bilinear chroma upsampling inside the unit
        const fx = Math.min(3, Math.max(0, (x - 0.5) / 2)), fy = Math.min(3, Math.max(0, (y - 0.5) / 2));
        const x0 = Math.floor(fx), y0 = Math.floor(fy), x1 = Math.min(3, x0 + 1), y1 = Math.min(3, y0 + 1), ax = fx - x0, ay = fy - y0;
        const bil = a => (a[y0 * 4 + x0] * (1 - ax) + a[y0 * 4 + x1] * ax) * (1 - ay) + (a[y1 * 4 + x0] * (1 - ax) + a[y1 * 4 + x1] * ax) * ay;
        const l = Y[y * 8 + x] + 128, b = bil(Cb), r = bil(Cr);
        const p = ((uy + y) * this.W + ux + x) * 4;
        this.rgba[p] = l + 1.402 * r; this.rgba[p + 1] = l - 0.344136 * b - 0.714136 * r; this.rgba[p + 2] = l + 1.772 * b; this.rgba[p + 3] = 255;
      }
    }
    // Display image: optional concealment of missing units, then light deblocking.
    image(fill) {
      const img = fill ? this.conceal() : Uint8ClampedArray.from(this.rgba);
      const W = this.W, H = this.H, thr = Math.min(70, 8 + this.T.y[0] * 1.2);
      const ok = (x, y) => fill || this.done[Math.floor(y / 8) * this.wu + Math.floor(x / 8)];
      const edge = (a, b, c, d) => {
        for (let k = 0; k < 3; k++) {
          const p1 = img[a + k], p0 = img[b + k], q0 = img[c + k], q1 = img[d + k], dd = q0 - p0;
          if (Math.abs(dd) >= thr) continue;
          img[a + k] = p1 + dd / 8; img[b + k] = p0 + dd * 3 / 8; img[c + k] = q0 - dd * 3 / 8; img[d + k] = q1 - dd / 8;
        }
      };
      for (let x = 8; x < W; x += 8) for (let y = 0; y < H; y++) if (ok(x - 1, y) && ok(x, y)) { const r = y * W * 4; edge(r + (x - 2) * 4, r + (x - 1) * 4, r + x * 4, r + (x + 1) * 4); }
      for (let y = 8; y < H; y += 8) for (let x = 0; x < W; x++) if (ok(x, y - 1) && ok(x, y)) { const R = W * 4; edge((y - 2) * R + x * 4, (y - 1) * R + x * 4, y * R + x * 4, (y + 1) * R + x * 4); }
      return img;
    }
    // Fill missing units from neighbours (used once reception has stopped).
    conceal() {
      const out = Uint8ClampedArray.from(this.rgba), W = this.W, have = Uint8Array.from(this.done);
      if (!this.count) return out;
      for (let pass = 0; pass < 64; pass++) {
        const fill = [];
        for (let u = 0; u < this.units; u++) {
          if (have[u]) continue;
          const ux = (u % this.wu) * 8, uy = Math.floor(u / this.wu) * 8;
          const up = uy > 0 && have[u - this.wu], dn = uy + 8 < this.H && have[u + this.wu];
          const lf = ux > 0 && have[u - 1], rt = ux + 8 < W && have[u + 1];
          if (!(up || dn || lf || rt)) continue;
          fill.push(u);
          for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
            const s = [0, 0, 0]; let wsum = 0;
            const add = (px, py, wt) => { const p = (py * W + px) * 4; for (let k = 0; k < 3; k++) s[k] += out[p + k] * wt; wsum += wt; };
            if (up) add(ux + x, uy - 1, 1 / (y + 1)); if (dn) add(ux + x, uy + 8, 1 / (8 - y));
            if (lf) add(ux - 1, uy + y, 1 / (x + 1)); if (rt) add(ux + 8, uy + y, 1 / (8 - x));
            const p = ((uy + y) * W + ux + x) * 4;
            for (let k = 0; k < 3; k++) out[p + k] = s[k] / wsum; out[p + 3] = 255;
          }
        }
        if (!fill.length) break;
        for (const u of fill) have[u] = 1;
      }
      return out;
    }
  }
  setTables(TABLES);
  return { CHUNK, NONE, QUALITY, encode, Decoder, meta, unmeta, setTables, AC_SYMS, DC_SYMS };
})();
