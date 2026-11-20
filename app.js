'use strict';
const $ = id => document.getElementById(id);
// Slider presets: [long side px, quality index]
const PRESETS = [[32, 5], [40, 6], [48, 6], [64, 7], [80, 8], [96, 9], [128, 10], [160, 11], [192, 12], [256, 13], [320, 14]];
const LEAD = 0.15, BATCH = 4;
let mode = 'normal', image = null, encoded = null, session = 0, tx = null, rx = null, wakeLock = null;

const say = s => { $('status').textContent = s; };
function tab(isTx) {
  $('tx').classList.toggle('hide', !isTx); $('rx').classList.toggle('hide', isTx);
  $('tabTx').classList.toggle('active', isTx); $('tabRx').classList.toggle('active', !isTx);
  say('');
}
$('tabTx').onclick = () => tab(true);
$('tabRx').onclick = () => tab(false);
if (/debug/.test(location.search)) $('debug').classList.remove('hide');

async function keepAwake(on) {
  try {
    if (on && 'wakeLock' in navigator && !wakeLock) wakeLock = await navigator.wakeLock.request('screen');
    if (!on && wakeLock) { await wakeLock.release(); wakeLock = null; }
  } catch (e) { wakeLock = null; }
}
const fmtTime = s => s < 60 ? `${Math.max(1, Math.round(s))} с` : `${Math.floor(s / 60)} мин ${String(Math.round(s % 60)).padStart(2, '0')} с`;

// ---------- sending ----------
$('file').onchange = async () => {
  const f = $('file').files[0]; if (!f) return;
  try {
    const url = URL.createObjectURL(f), img = new Image();
    await new Promise((ok, no) => { img.onload = ok; img.onerror = () => no(Error('не удалось открыть')); img.src = url; });
    URL.revokeObjectURL(url);
    image = img; $('choose').textContent = 'Другое фото'; prepare();
  } catch (e) { say('Ошибка: ' + e.message); }
};
let prepTimer = 0;
try { if (localStorage.getItem('pw-quiet') === '1') { $('quiet').checked = true; mode = 'quiet'; } } catch (e) {}
$('quiet').onchange = () => { mode = $('quiet').checked ? 'quiet' : 'normal'; try { localStorage.setItem('pw-quiet', $('quiet').checked ? '1' : '0'); } catch (e) {} prepare(); };
const frameSec = () => Modem.MODES[mode].frameSec, preSec = () => mode === 'quiet' ? 0.12 : 0;
$('level').oninput = () => { clearTimeout(prepTimer); prepTimer = setTimeout(prepare, 60); };

function fit(w, h, L) {
  let wu, hu;
  if (w >= h) { wu = Math.max(1, Math.round(L / 8)); hu = Math.max(1, Math.round(wu * h / w)); }
  else { hu = Math.max(1, Math.round(L / 8)); wu = Math.max(1, Math.round(hu * w / h)); }
  return [Math.min(63, wu), Math.min(63, hu)];
}
function scaled(img, W, H) {
  // centre-crop to the target aspect, then downscale in halving steps for a clean small image
  const iw = img.naturalWidth, ih = img.naturalHeight, ta = W / H;
  let sx = 0, sy = 0, sw = iw, sh = ih;
  if (iw / ih > ta) { sw = Math.round(ih * ta); sx = (iw - sw) >> 1; } else { sh = Math.round(iw / ta); sy = (ih - sh) >> 1; }
  let c = document.createElement('canvas'), w = sw, h = sh;
  c.width = w; c.height = h; c.getContext('2d').drawImage(img, sx, sy, sw, sh, 0, 0, w, h);
  while (w / 2 >= W * 1.5) {
    const n = document.createElement('canvas'); n.width = Math.round(w / 2); n.height = Math.round(h / 2);
    const g = n.getContext('2d'); g.imageSmoothingQuality = 'high'; g.drawImage(c, 0, 0, n.width, n.height);
    c = n; w = n.width; h = n.height;
  }
  const o = document.createElement('canvas'); o.width = W; o.height = H;
  const g = o.getContext('2d'); g.imageSmoothingQuality = 'high'; g.drawImage(c, 0, 0, W, H);
  return g.getImageData(0, 0, W, H).data;
}
function prepare() {
  if (!image || tx) return;
  const [L, q] = PRESETS[+$('level').value];
  const [wu, hu] = fit(image.naturalWidth, image.naturalHeight, L);
  const rgba = scaled(image, wu * 8, hu * 8);
  encoded = Codec.encode(rgba, wu, hu, q);
  session = (Math.random() * 256) | 0;
  // preview exactly what the receiver will get
  const d = new Codec.Decoder(encoded.meta);
  encoded.chunks.forEach((c, i) => d.addChunk(i, c.first, c.off, c.bytes));
  const cv = $('preview'); cv.width = d.W; cv.height = d.H; cv.style.aspectRatio = d.W + '/' + d.H;
  cv.getContext('2d').putImageData(new ImageData(d.image(false), d.W, d.H), 0, 0);
  cv.classList.remove('hide'); $('emptyTx').classList.add('hide');
  const secs = LEAD + preSec() + encoded.chunks.length * frameSec() + 0.1;
  $('estimate').innerHTML = `≈ ${fmtTime(secs)}<small>${d.W}×${d.H} px · ${encoded.chunks.length} пакетов</small>`;
  $('send').disabled = false; $('downloadWav').disabled = false;
}
function framePayload(i) {
  const c = encoded.chunks[i], p = new Uint8Array(Modem.PAYLOAD);
  p[0] = session; p[1] = encoded.meta & 255; p[2] = encoded.meta >> 8; p[3] = i & 255; p[4] = i >> 8;
  p[5] = c.first & 255; p[6] = (c.first >> 8) | ((c.off & 15) << 4); p[7] = c.off >> 4;
  p.set(c.bytes, 8);
  return p;
}
function batchWave(start, sr, m) {
  const syms = [], end = Math.min(encoded.chunks.length, start + BATCH);
  for (let i = start; i < end; i++) syms.push(...Modem.frameSymbols(framePayload(i), m));
  return Modem.synth(syms, sr, m, { fadeIn: start === 0 && m === 'quiet', fadeOut: end === encoded.chunks.length });
}
$('send').onclick = async () => {
  if (!encoded || tx) return;
  const ctx = new AudioContext(); await ctx.resume();
  const m = mode, fs = frameSec(), pre = preSec();
  const n = encoded.chunks.length, t0 = ctx.currentTime + LEAD + 0.05 + pre, total = n * fs;
  tx = { ctx, sources: [], next: 0, stop: false };
  $('send').classList.add('hide'); $('stopTx').classList.remove('hide'); $('level').disabled = true; $('quiet').disabled = true;
  keepAwake(true);
  const pump = () => {
    while (tx.next < n && t0 + tx.next * fs - ctx.currentTime < 3) {
      const w = batchWave(tx.next, ctx.sampleRate, m), b = ctx.createBuffer(1, w.length, ctx.sampleRate);
      b.copyToChannel(w, 0);
      const s = ctx.createBufferSource(); s.buffer = b; s.connect(ctx.destination);
      s.start(t0 + tx.next * fs - (tx.next === 0 ? pre : 0)); tx.sources.push(s); tx.next += BATCH;
    }
    const done = Math.min(1, Math.max(0, (ctx.currentTime - t0) / total));
    $('txBar').style.width = (done * 100) + '%';
    say(`Передаём · осталось ${fmtTime(Math.max(0, total * (1 - done)))}`);
    if (done >= 1 && ctx.currentTime > t0 + total + 0.1) finishTx('✓ Передача завершена');
  };
  tx.timer = setInterval(pump, 150); pump();
};
function finishTx(msg) {
  if (!tx) return;
  clearInterval(tx.timer); tx.sources.forEach(s => { try { s.stop(); } catch (e) {} });
  tx.ctx.close().catch(() => {}); tx = null;
  $('send').classList.remove('hide'); $('stopTx').classList.add('hide'); $('level').disabled = false; $('quiet').disabled = false;
  $('txBar').style.width = '0'; keepAwake(false); say(msg);
}
$('stopTx').onclick = () => finishTx('Передача остановлена');

// ---------- receiving ----------
let dec = null, decKey = -1, lastFrameAt = 0, finalShown = false, drawPending = false;
// Listen for both modes at once; the stronger band drives the signal meter.
function newReceiver() {
  const parts = {};
  const show = () => {
    const st = { good: 0, bad: 0, level: 0 };
    for (const k in parts) { st.good += parts[k].good; st.bad += parts[k].bad; st.level = Math.max(st.level, parts[k].level * (k === 'quiet' ? 4 : 1)); }
    const bars = Math.max(0, Math.min(5, Math.round((Math.log10(st.level + 1e-6) + 3.2) * 2.2)));
    const meter = '<span class="meter">' + Array.from({ length: 5 }, (_, i) => `<span class="${i < bars ? 'on' : ''}"></span>`).join('') + '</span>';
    $('rxStats').innerHTML = `Сигнал${meter} · пакетов ${st.good}` + (lastMode === 'quiet' ? ' · 🤫 тихий' : '');
  };
  const rs = ['normal', 'quiet'].map(m => new Modem.Receiver((p, r) => { lastMode = r.mode; onFrame(p); }, st => { parts[m] = st; show(); }, m));
  return { feed: (x, sr) => { for (const r of rs) r.feed(x, sr); } };
}
let lastMode = null;
function onFrame(p) {
  const sess = p[0], meta = p[1] | p[2] << 8, seq = p[3] | p[4] << 8;
  const first = p[5] | (p[6] & 15) << 8, off = (p[6] >> 4) | p[7] << 4;
  const m = Codec.unmeta(meta);
  if (!m.wu || !m.hu) return;
  const key = sess << 16 | meta;
  if (key !== decKey) {
    dec = new Codec.Decoder(meta); decKey = key; finalShown = false;
    const cv = $('received'); cv.width = dec.W; cv.height = dec.H; cv.style.aspectRatio = dec.W + '/' + dec.H;
    const g = cv.getContext('2d'); g.fillStyle = '#10121a'; g.fillRect(0, 0, dec.W, dec.H);
    cv.classList.remove('hide'); $('emptyRx').classList.add('hide'); $('save').classList.add('hide');
  }
  lastFrameAt = performance.now();
  if (dec.addChunk(seq, first, off, p.subarray(8, 8 + Codec.CHUNK))) scheduleDraw();
  const pct = Math.round(dec.count / dec.units * 100);
  $('rxBar').style.width = pct + '%';
  if (dec.count === dec.units) { say('✓ Фото получено'); finalShown = true; $('save').classList.remove('hide'); }
  else say(`Принимаем · ${pct}%`);
}
function scheduleDraw() {
  if (drawPending) return; drawPending = true;
  requestAnimationFrame(() => { drawPending = false; draw(false); });
}
function draw(fill) {
  if (!dec) return;
  $('received').getContext('2d').putImageData(new ImageData(dec.image(fill), dec.W, dec.H), 0, 0);
}
setInterval(() => {
  // once frames stop arriving, fill the holes so the picture looks complete
  if (dec && !finalShown && lastFrameAt && performance.now() - lastFrameAt > 2500 && dec.count < dec.units) {
    finalShown = true; draw(true); $('save').classList.remove('hide');
    say(`Получено ${Math.round(dec.count / dec.units * 100)}% · пропуски дорисованы. Повтори передачу, чтобы дополнить`);
  }
}, 500);
$('listen').onclick = async () => {
  try {
    if (!navigator.mediaDevices?.getUserMedia) throw Error('нужен HTTPS');
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 } });
    const ctx = new AudioContext(); await ctx.resume();
    const receiver = newReceiver(), src = ctx.createMediaStreamSource(stream);
    let node = null;
    if (ctx.audioWorklet) {
      try { await ctx.audioWorklet.addModule('capture-worklet.js'); node = new AudioWorkletNode(ctx, 'pixelwave-capture'); node.port.onmessage = e => receiver.feed(e.data, ctx.sampleRate); }
      catch (e) { node = null; }
    }
    if (!node) { node = ctx.createScriptProcessor(2048, 1, 1); node.onaudioprocess = e => { e.outputBuffer.getChannelData(0).fill(0); receiver.feed(e.inputBuffer.getChannelData(0), ctx.sampleRate); }; }
    const mute = ctx.createGain(); mute.gain.value = 0;
    src.connect(node); node.connect(mute); mute.connect(ctx.destination);
    rx = { ctx, stream, node, src };
    $('listen').classList.add('hide'); $('stopRx').classList.remove('hide');
    keepAwake(true); say('Слушаем… Запусти передачу на другом телефоне');
  } catch (e) { say('Микрофон: ' + e.message); }
};
async function stopRx() {
  if (!rx) return;
  rx.node.disconnect(); rx.src.disconnect(); rx.stream.getTracks().forEach(t => t.stop());
  await rx.ctx.close().catch(() => {}); rx = null;
  $('listen').classList.remove('hide'); $('stopRx').classList.add('hide'); keepAwake(false);
}
$('stopRx').onclick = async () => { await stopRx(); if (dec && dec.count < dec.units) draw(true); say('Приём остановлен'); };
$('save').onclick = () => {
  if (!dec) return;
  // save upscaled so the small picture is usable
  const k = Math.max(1, Math.ceil(512 / Math.max(dec.W, dec.H))), src = $('received');
  const c = document.createElement('canvas'); c.width = dec.W * k; c.height = dec.H * k;
  const g = c.getContext('2d'); g.imageSmoothingQuality = 'high'; g.drawImage(src, 0, 0, c.width, c.height);
  c.toBlob(b => { const a = document.createElement('a'); a.href = URL.createObjectURL(b); a.download = 'pixelwave.png'; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 30000); }, 'image/png');
};

// ---------- debug: WAV ----------
function wavBlob(samples, sr) {
  const b = new ArrayBuffer(44 + samples.length * 2), v = new DataView(b);
  for (const [i, s] of [[0, 'RIFF'], [8, 'WAVE'], [12, 'fmt '], [36, 'data']]) for (let j = 0; j < 4; j++) v.setUint8(i + j, s.charCodeAt(j));
  v.setUint32(4, b.byteLength - 8, true); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, sr, true); v.setUint32(28, sr * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) v.setInt16(44 + i * 2, Math.round(Math.max(-1, Math.min(1, samples[i])) * 32767), true);
  return new Blob([b], { type: 'audio/wav' });
}
$('downloadWav').onclick = () => {
  const sr = 48000, syms = []; encoded.chunks.forEach((_, i) => syms.push(...Modem.frameSymbols(framePayload(i), mode)));
  const w = Modem.synth(syms, sr, mode, { fadeIn: mode === 'quiet', fadeOut: true }), all = new Float32Array(w.length + sr); all.set(w, Math.round(sr * 0.3));
  const a = document.createElement('a'); a.href = URL.createObjectURL(wavBlob(all, sr)); a.download = `pixelwave-v6-${mode}.wav`; a.click();
};
$('wav').onchange = async () => {
  const f = $('wav').files[0]; if (!f) return;
  const ctx = new AudioContext(), audio = await ctx.decodeAudioData(await f.arrayBuffer()), s = audio.getChannelData(0);
  const r = newReceiver(); tab(false);
  for (let i = 0; i < s.length; i += 4096) { r.feed(s.subarray(i, i + 4096), audio.sampleRate); if (i % 65536 === 0) await new Promise(ok => setTimeout(ok, 0)); }
  ctx.close();
};

if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
