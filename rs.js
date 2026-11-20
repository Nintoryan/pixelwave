'use strict';
// Reed–Solomon over GF(256) (poly 0x11d, fcr 0) with errors-and-erasures decoding.
// RS.encode(msg, nsym) -> Uint8Array(msg.length + nsym)
// RS.decode(codeword, nsym, erasures?) -> Uint8Array(message) or null
const RS = (() => {
  const EXP = new Uint8Array(512), LOG = new Uint8Array(256);
  let x = 1;
  for (let i = 0; i < 255; i++) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 256) x ^= 0x11d; }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
  const mul = (a, b) => (a && b) ? EXP[LOG[a] + LOG[b]] : 0;
  const div = (a, b) => { if (!b) throw Error('div0'); return a ? EXP[(LOG[a] + 255 - LOG[b]) % 255] : 0; };
  const pow = (a, p) => EXP[((LOG[a] * p) % 255 + 255) % 255];
  const inv = a => EXP[255 - LOG[a]];
  // Polynomials: arrays, highest degree first.
  const pScale = (p, s) => p.map(c => mul(c, s));
  const pAdd = (p, q) => {
    const r = new Array(Math.max(p.length, q.length)).fill(0);
    for (let i = 0; i < p.length; i++) r[i + r.length - p.length] = p[i];
    for (let i = 0; i < q.length; i++) r[i + r.length - q.length] ^= q[i];
    return r;
  };
  const pMul = (p, q) => {
    const r = new Array(p.length + q.length - 1).fill(0);
    for (let j = 0; j < q.length; j++) for (let i = 0; i < p.length; i++) r[i + j] ^= mul(p[i], q[j]);
    return r;
  };
  const pEval = (p, v) => { let y = p[0]; for (let i = 1; i < p.length; i++) y = mul(y, v) ^ p[i]; return y; };
  const gens = {};
  function generator(nsym) {
    if (gens[nsym]) return gens[nsym];
    let g = [1];
    for (let i = 0; i < nsym; i++) g = pMul(g, [1, pow(2, i)]);
    return (gens[nsym] = g);
  }
  function encode(msg, nsym) {
    const g = generator(nsym), out = new Uint8Array(msg.length + nsym);
    out.set(msg);
    for (let i = 0; i < msg.length; i++) {
      const c = out[i];
      if (c) for (let j = 1; j < g.length; j++) out[i + j] ^= mul(g[j], c);
    }
    out.set(msg);
    return out;
  }
  function syndromes(msg, nsym) {
    const s = new Array(nsym);
    for (let i = 0; i < nsym; i++) s[i] = pEval(msg, pow(2, i));
    return s;
  }
  function decode(cw, nsym, erasures) {
    const n = cw.length, msg = Array.from(cw);
    erasures = (erasures || []).filter((v, i, a) => v >= 0 && v < n && a.indexOf(v) === i);
    if (erasures.length > nsym) return null;
    for (const e of erasures) msg[e] = 0;
    const synd = syndromes(msg, nsym);
    if (synd.every(v => v === 0)) return Uint8Array.from(msg.slice(0, n - nsym));
    // Forney syndromes remove the erasures' contribution.
    const fs = synd.slice();
    for (const e of erasures) {
      const xv = pow(2, n - 1 - e);
      for (let j = 0; j < fs.length - 1; j++) fs[j] = mul(fs[j], xv) ^ fs[j + 1];
    }
    // Berlekamp–Massey on Forney syndromes (lowest-first syndromes, poly highest-first).
    let errLoc = [1], oldLoc = [1];
    const nE = erasures.length;
    for (let i = 0; i < nsym - nE; i++) {
      let delta = fs[i];
      for (let j = 1; j < errLoc.length; j++) delta ^= mul(errLoc[errLoc.length - 1 - j], fs[i - j]);
      oldLoc = oldLoc.concat([0]);
      if (delta) {
        if (oldLoc.length > errLoc.length) {
          const nl = pScale(oldLoc, delta);
          oldLoc = pScale(errLoc, inv(delta));
          errLoc = nl;
        }
        errLoc = pAdd(errLoc, pScale(oldLoc, delta));
      }
    }
    while (errLoc.length && errLoc[0] === 0) errLoc.shift();
    const nErr = errLoc.length - 1;
    if (nErr * 2 + nE > nsym) return null;
    // Chien search
    const errPos = [];
    const rev = errLoc.slice().reverse();
    for (let i = 0; i < n; i++) if (pEval(rev, pow(2, i)) === 0) errPos.push(n - 1 - i);
    if (errPos.length !== nErr) return null;
    const pos = erasures.concat(errPos);
    // Forney algorithm for magnitudes
    const coefPos = pos.map(p => n - 1 - p);
    let loc = [1];
    for (const cp of coefPos) loc = pMul(loc, pAdd([1], [pow(2, cp), 0]));
    const sr = synd.slice().reverse();
    let prod = pMul(sr, loc);
    const ev = prod.slice(prod.length - Math.min(nsym, prod.length)); // S·Λ mod x^nsym
    const X = coefPos.map(cp => pow(2, cp));
    for (let i = 0; i < X.length; i++) {
      const xi = X[i], xiInv = inv(xi);
      let lp = 1;
      for (let j = 0; j < X.length; j++) if (j !== i) lp = mul(lp, 1 ^ mul(xiInv, X[j]));
      if (!lp) return null;
      const y = pEval(ev, xiInv);
      msg[pos[i]] ^= div(y, lp);
    }
    const check = syndromes(msg, nsym);
    if (!check.every(v => v === 0)) return null;
    return Uint8Array.from(msg.slice(0, n - nsym));
  }
  return { encode, decode };
})();
