(() => {
  'use strict';
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => [...document.querySelectorAll(s)];

  // Must match BG_WORK_WIDTH in resizer.py — used to mirror ffmpeg's blur on the canvas.
  const BG_WORK_WIDTH = 160;
  const STORE_KEY = 'resizer.settings.v1';

  const state = {
    upload: null,      // {id, name, info, url}
    job: null,
    pollTimer: null,
    settings: {
      bitrate: 5, height: 1080, formats: ['16x9', '1x1'], blur: 50, dim: 30,
      codec: 'h264', encoder: 'auto', hw_decode: true,
    },
    encoders: null,
  };

  // ---------------------------------------------------------------- settings
  try {
    const saved = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
    if (saved) Object.assign(state.settings, saved);
  } catch (_) { /* storage unavailable */ }
  const persist = () => { try { localStorage.setItem(STORE_KEY, JSON.stringify(state.settings)); } catch (_) {} };

  const fmtBytes = (b) => b >= 1e9 ? (b / 1e9).toFixed(2) + ' ГБ' : (b / 1e6).toFixed(1) + ' МБ';
  const fmtTime = (s) => {
    if (s == null || !isFinite(s)) return '—';
    s = Math.max(0, Math.round(s));
    const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), sec = s % 60;
    return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
  };
  const toast = (msg) => {
    const t = $('#toast');
    t.textContent = msg; t.hidden = false;
    clearTimeout(toast.t); toast.t = setTimeout(() => (t.hidden = true), 5000);
  };
  const setRangeFill = (el) => {
    const p = (el.value - el.min) / (el.max - el.min) * 100;
    el.style.setProperty('--p', p + '%');
  };

  function applySettingsToUI() {
    const s = state.settings;
    $('#bitrate').value = Math.min(30, s.bitrate); $('#bitrateNum').value = s.bitrate;
    $('#blur').value = s.blur; $('#blurVal').textContent = s.blur;
    $('#dim').value = s.dim; $('#dimVal').textContent = s.dim + '%';
    $$('input[name=fmt]').forEach((c) => (c.checked = s.formats.includes(c.value)));
    $$('#resSeg button').forEach((b) => b.classList.toggle('on', +b.dataset.v === s.height));
    $$('#codecSeg button').forEach((b) => b.classList.toggle('on', b.dataset.v === s.codec));
    $('#hwdec').checked = s.hw_decode;
    $$('.range').forEach(setRangeFill);
    updateDerived();
  }

  function updateDerived() {
    const s = state.settings;
    const h = s.height, w = Math.round(h * 16 / 9 / 2) * 2;
    $('#dim169').textContent = `${w}×${h}`;
    $('#dim11').textContent = `${h}×${h}`;
    $$('.stage').forEach((st) => st.classList.toggle('off', !s.formats.includes(st.dataset.fmt)));
    const d = state.upload?.info?.duration;
    $('#sizeEst').textContent = d
      ? `≈ ${fmtBytes(s.bitrate * 1e6 / 8 * d)} на кожен файл (${fmtTime(d)})`
      : 'Для соцмереж 1080p достатньо 5–8 Мбіт/с';
    updateRenderBtn();
  }

  function updateRenderBtn() {
    const running = state.job && (state.job.status === 'running' || state.job.status === 'queued');
    $('#renderBtn').disabled = !state.upload || !state.settings.formats.length || running;
  }

  // bitrate
  $('#bitrate').addEventListener('input', (e) => {
    state.settings.bitrate = +e.target.value; $('#bitrateNum').value = e.target.value;
    setRangeFill(e.target); updateDerived(); persist();
  });
  $('#bitrateNum').addEventListener('change', (e) => {
    let v = Math.max(0.5, Math.min(100, +e.target.value || 5));
    e.target.value = v; state.settings.bitrate = v;
    $('#bitrate').value = Math.min(30, v); setRangeFill($('#bitrate')); updateDerived(); persist();
  });
  $('#blur').addEventListener('input', (e) => {
    state.settings.blur = +e.target.value; $('#blurVal').textContent = e.target.value;
    setRangeFill(e.target); persist(); drawOnce();
  });
  $('#dim').addEventListener('input', (e) => {
    state.settings.dim = +e.target.value; $('#dimVal').textContent = e.target.value + '%';
    setRangeFill(e.target); persist(); drawOnce();
  });
  $$('input[name=fmt]').forEach((c) => c.addEventListener('change', () => {
    state.settings.formats = $$('input[name=fmt]').filter((x) => x.checked).map((x) => x.value);
    updateDerived(); persist();
  }));
  const bindSeg = (sel, key, cast) => $$(sel + ' button').forEach((b) => b.addEventListener('click', () => {
    $$(sel + ' button').forEach((x) => x.classList.toggle('on', x === b));
    state.settings[key] = cast(b.dataset.v);
    if (key === 'codec') fillEncoderSelect();
    updateDerived(); persist();
  }));
  bindSeg('#resSeg', 'height', Number);
  bindSeg('#codecSeg', 'codec', String);
  $('#encoder').addEventListener('change', (e) => { state.settings.encoder = e.target.value; persist(); });
  $('#hwdec').addEventListener('change', (e) => { state.settings.hw_decode = e.target.checked; persist(); });

  // ---------------------------------------------------------------- encoders
  function fillEncoderSelect() {
    const list = state.encoders?.[state.settings.codec] || [];
    const sel = $('#encoder');
    const best = list[0];
    sel.innerHTML = '';
    sel.append(new Option(best ? `Авто — ${best.label}` : 'Авто', 'auto'));
    list.forEach((e) => sel.append(new Option(`${e.label} · ${e.hardware ? 'GPU' : 'CPU'}`, e.id)));
    if (![...sel.options].some((o) => o.value === state.settings.encoder)) state.settings.encoder = 'auto';
    sel.value = state.settings.encoder;
  }

  async function loadInfo() {
    try {
      const r = await fetch('/api/info');
      const info = await r.json();
      state.encoders = info.encoders;
      fillEncoderSelect();
      const best = (info.encoders.h264 || [])[0];
      const chip = $('#encChip');
      if (best && best.hardware) {
        chip.className = 'chip chip-ok';
        chip.lastElementChild.textContent = `${best.label} · апаратне прискорення`;
      } else {
        chip.className = 'chip chip-warn';
        chip.lastElementChild.textContent = 'CPU-рендер · GPU-енкодер не знайдено';
      }
    } catch (_) {
      toast('Сервер недоступний. Запустіть resizer.py ще раз.');
    }
  }

  // ---------------------------------------------------------------- upload
  const drop = $('#drop');
  const fileInput = $('#fileInput');
  ['dragenter', 'dragover'].forEach((ev) => document.addEventListener(ev, (e) => {
    e.preventDefault(); drop.classList.add('over');
  }));
  ['dragleave', 'drop'].forEach((ev) => document.addEventListener(ev, (e) => {
    e.preventDefault();
    if (ev === 'drop' || e.target === document.documentElement || !e.relatedTarget) drop.classList.remove('over');
  }));
  document.addEventListener('drop', (e) => {
    const f = e.dataTransfer?.files?.[0];
    if (f) upload(f);
  });
  fileInput.addEventListener('change', () => { if (fileInput.files[0]) upload(fileInput.files[0]); fileInput.value = ''; });
  $('#changeFile').addEventListener('click', () => fileInput.click());

  let uploading = false;
  function upload(file) {
    if (uploading) return;
    if (state.job && state.job.status === 'running') { toast('Зачекайте завершення рендеру або скасуйте його'); return; }
    uploading = true;
    const prog = $('#upProg');
    drop.hidden = false; drop.classList.remove('compact');
    prog.hidden = false;
    const bar = prog.querySelector('.bar span');
    const txt = prog.querySelector('.up-text');
    bar.style.width = '0%';
    txt.textContent = `${file.name} · ${fmtBytes(file.size)}`;

    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/upload');
    xhr.setRequestHeader('X-Filename', encodeURIComponent(file.name));
    xhr.upload.onprogress = (e) => {
      if (!e.lengthComputable) return;
      const p = e.loaded / e.total;
      bar.style.width = (p * 100).toFixed(1) + '%';
      txt.textContent = p < 1 ? `Завантаження ${(p * 100).toFixed(0)}% · ${fmtBytes(e.loaded)} з ${fmtBytes(e.total)}` : 'Аналізую відео…';
    };
    xhr.onload = () => {
      uploading = false; prog.hidden = true;
      let res = {};
      try { res = JSON.parse(xhr.responseText); } catch (_) {}
      if (xhr.status !== 200) { toast(res.error || 'Не вдалося завантажити файл'); return; }
      onUploaded(res);
    };
    xhr.onerror = () => { uploading = false; prog.hidden = true; toast('Помилка завантаження'); };
    xhr.send(file);
  }

  function onUploaded(up) {
    state.upload = up;
    const i = up.info;
    drop.classList.add('compact');
    drop.hidden = true;
    $('#fileCard').hidden = false;
    $('#fileName').textContent = up.name;
    const tags = [
      `${i.width}×${i.height}`, fmtTime(i.duration), i.fps ? `${i.fps} fps` : null,
      (i.video_codec || '').toUpperCase(), fmtBytes(i.size),
    ].filter(Boolean).map((t) => `<span class="tag">${t}</span>`);
    if (i.width > i.height) tags.push('<span class="tag warn">Не вертикальне — буде вписане в кадр</span>');
    $('#fileTags').innerHTML = tags.join('');
    $('#results').hidden = true;
    $('#jobBox').hidden = true;
    state.job = null;
    setupPreview(up.url);
    updateDerived();
  }

  // ---------------------------------------------------------------- preview
  const video = $('#srcVideo');
  const canvases = { '16x9': $('#cv169'), '1x1': $('#cv11') };
  const ctxs = {};
  let raf = 0;

  function sizeCanvases() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    for (const [fmt, cv] of Object.entries(canvases)) {
      const w = Math.max(2, Math.round(cv.clientWidth * dpr));
      const h = fmt === '1x1' ? w : Math.round(w * 9 / 16);
      if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
      ctxs[fmt] = cv.getContext('2d');
    }
    drawOnce();
  }
  window.addEventListener('resize', sizeCanvases);

  function setupPreview(url) {
    $('#previewWrap').hidden = false;
    video.src = url;
    video.currentTime = 0;
    video.addEventListener('loadeddata', () => { sizeCanvases(); drawOnce(); }, { once: true });
    requestAnimationFrame(sizeCanvases);
    setPlaying(false);
  }

  function draw(fmt) {
    const ctx = ctxs[fmt]; const cv = canvases[fmt];
    if (!ctx || !video.videoWidth) return;
    const W = cv.width, H = cv.height, vw = video.videoWidth, vh = video.videoHeight;
    const s = state.settings;

    // Background: cover-scaled, blurred + darkened (mirrors the ffmpeg graph).
    const cover = Math.max(W / vw, H / vh);
    const bw = vw * cover, bh = vh * cover;
    const radius = 1 + Math.round(s.blur / 100 * 11);
    const boxSigma = Math.sqrt(((2 * radius + 1) ** 2 - 1) / 12) * Math.SQRT2;
    const sigma = boxSigma * (bw / BG_WORK_WIDTH);
    const pad = sigma * 2;
    ctx.save();
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);
    ctx.filter = `blur(${sigma.toFixed(1)}px) brightness(${1 - s.dim / 100})`;
    ctx.drawImage(video, (W - bw) / 2 - pad, (H - bh) / 2 - pad, bw + pad * 2, bh + pad * 2);
    ctx.restore();

    // Foreground: full height, centered.
    const fit = Math.min(W / vw, H / vh);
    const fw = vw * fit, fh = vh * fit;
    ctx.drawImage(video, (W - fw) / 2, (H - fh) / 2, fw, fh);
  }

  function drawOnce() { draw('16x9'); draw('1x1'); updateTime(); }
  function loop() {
    drawOnce();
    raf = video.paused ? 0 : requestAnimationFrame(loop);
  }
  function setPlaying(p) {
    $('#playBtn').classList.toggle('playing', p);
  }
  $('#playBtn').addEventListener('click', () => {
    if (!video.src) return;
    if (video.paused) video.play(); else video.pause();
  });
  video.addEventListener('play', () => { setPlaying(true); if (!raf) raf = requestAnimationFrame(loop); });
  video.addEventListener('pause', () => setPlaying(false));
  video.addEventListener('ended', () => setPlaying(false));
  video.addEventListener('seeked', drawOnce);
  $('#muteBtn').addEventListener('click', () => {
    video.muted = !video.muted;
    $('#muteBtn').classList.toggle('muted', video.muted);
  });
  $('#muteBtn').classList.add('muted');

  const seek = $('#seek');
  let seeking = false;
  seek.addEventListener('input', () => {
    seeking = true;
    if (video.duration) video.currentTime = seek.value / 1000 * video.duration;
    setRangeFill(seek);
  });
  seek.addEventListener('change', () => (seeking = false));
  function updateTime() {
    if (!video.duration) return;
    if (!seeking) { seek.value = video.currentTime / video.duration * 1000; setRangeFill(seek); }
    $('#timeLbl').textContent = `${fmtTime(video.currentTime)} / ${fmtTime(video.duration)}`;
  }
  video.addEventListener('timeupdate', () => { if (video.paused) updateTime(); });

  // ---------------------------------------------------------------- render
  $('#renderBtn').addEventListener('click', async () => {
    if (!state.upload) return;
    video.pause();
    $('#results').hidden = true;
    const body = { id: state.upload.id, ...state.settings };
    try {
      const r = await fetch('/api/render', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      const job = await r.json();
      if (!r.ok) { toast(job.error || 'Не вдалося запустити рендер'); return; }
      showJob(job);
      poll(job.id);
    } catch (_) { toast('Сервер недоступний'); }
  });

  $('#cancelBtn').addEventListener('click', async () => {
    if (!state.job) return;
    await fetch(`/api/jobs/${state.job.id}/cancel`, { method: 'POST' }).catch(() => {});
  });

  function poll(id) {
    clearTimeout(state.pollTimer);
    const tick = async () => {
      try {
        const r = await fetch(`/api/jobs/${id}`);
        const job = await r.json();
        showJob(job);
        if (job.status === 'running' || job.status === 'queued') state.pollTimer = setTimeout(tick, 400);
      } catch (_) { state.pollTimer = setTimeout(tick, 1500); }
    };
    tick();
  }

  const encLabel = (id) => {
    for (const list of Object.values(state.encoders || {})) {
      const e = list.find((x) => x.id === id);
      if (e) return `${e.label}${e.hardware ? ' · GPU' : ''}`;
    }
    return id || '—';
  };

  function showJob(job) {
    const prev = state.job?.status;
    state.job = job;
    const box = $('#jobBox');
    box.hidden = false;
    box.classList.toggle('done', job.status === 'done');
    const pct = job.progress * 100;
    $('#jobBar').style.width = pct.toFixed(1) + '%';
    $('#jobPct').textContent = Math.floor(pct) + '%';
    $('#jobSpeed').textContent = job.speed ? job.speed.toFixed(1) + '×' : '—';
    $('#jobEnc').textContent = encLabel(job.encoder);
    const running = job.status === 'running' || job.status === 'queued';
    $('#cancelBtn').hidden = !running;
    $('#jobErr').hidden = job.status !== 'error';
    const labels = {
      queued: 'У черзі…', running: 'Рендеринг…', done: `Готово за ${fmtTime(job.elapsed)}`,
      error: 'Помилка рендеру', cancelled: 'Скасовано',
    };
    $('#jobStatus').textContent = labels[job.status] || job.status;
    $('#jobEta').textContent = running ? fmtTime(job.eta) : fmtTime(0);
    if (job.status === 'error') $('#jobErr').textContent = job.error;
    if (job.status === 'done' && prev !== 'done') showResults(job);
    updateRenderBtn();
  }

  function showResults(job) {
    const grid = $('#resultGrid');
    grid.innerHTML = '';
    grid.classList.toggle('single', job.outputs.length === 1);
    for (const o of job.outputs) {
      const el = document.createElement('div');
      el.className = 'result';
      const v = document.createElement('video');
      v.controls = true; v.preload = 'metadata'; v.playsInline = true;
      v.src = o.url + '?t=' + Date.now();
      v.style.aspectRatio = `${o.width} / ${o.height}`;
      const foot = document.createElement('div');
      foot.className = 'result-foot';
      foot.innerHTML = `<div class="result-info"><b>${o.label}</b>${o.width}×${o.height} · ${fmtBytes(o.size)}</div>`;
      const a = document.createElement('a');
      a.className = 'btn btn-sm btn-dl';
      a.href = o.url + '?download=1';
      a.download = o.file;
      a.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v11m0 0 4.5-4.5M12 15l-4.5-4.5"/><path d="M5 19h14"/></svg>Завантажити';
      foot.append(a);
      el.append(v, foot);
      grid.append(el);
    }
    $('#resultHint').textContent = `збережено в папці output · ${fmtTime(job.elapsed)}, ${encLabel(job.encoder)}`;
    $('#results').hidden = false;
    $('#results').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  $('#openFolder').addEventListener('click', () => fetch('/api/open-folder', { method: 'POST' }));

  // Keeps the local server alive while this tab is open (Resizer.app stops it when idle).
  setInterval(() => fetch('/api/ping').catch(() => {}), 15000);

  applySettingsToUI();
  loadInfo();
})();
