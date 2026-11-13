(() => {
  'use strict';
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => [...document.querySelectorAll(s)];

  // Must match BG_WORK_WIDTH in resizer.py — used to mirror ffmpeg's blur on the canvas.
  const BG_WORK_WIDTH = 160;
  const STORE_KEY = 'resizer.settings.v1';
  // Set by the macOS app window (Resizer.app); in a browser it is undefined.
  const NATIVE = !!window.RESIZER_NATIVE;
  const ASPECTS = { '9x16': [9, 16], '4x5': [4, 5], '1x1': [1, 1], '16x9': [16, 9] };
  const ACTIVE = ['queued', 'running'];

  const state = {
    items: [],         // queue: {key, file, name, state, pct, upload, job, el}
    sel: null,         // selected queue item (preview + results)
    batch: [],         // items of the current render run, for the overall progress
    pollTimer: null,
    outputDir: '',
    settings: {
      bitrate: 5, height: 1080, formats: ['9x16', '4x5', '1x1', '16x9'], blur: 50, dim: 30,
      codec: 'h264', encoder: 'auto', hw_decode: true, logo: true,
    },
    encoders: null,
    assets: null,      // /api/assets: logo, logo_pos (per format), packshot, fade_frames
  };

  // ---------------------------------------------------------------- settings
  try {
    const saved = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
    // Settings saved before 9:16 existed: switch the new format on once.
    if (saved && !('logo' in saved) && Array.isArray(saved.formats)) saved.formats = ['9x16', ...saved.formats];
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
  const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const toast = (msg) => {
    const t = $('#toast');
    t.textContent = msg; t.hidden = false;
    clearTimeout(toast.t); toast.t = setTimeout(() => (t.hidden = true), 5000);
  };
  const setRangeFill = (el) => {
    const p = (el.value - el.min) / (el.max - el.min) * 100;
    el.style.setProperty('--p', p + '%');
  };
  // Mirrors out_size() in resizer.py: the resolution is the short side of the frame.
  const outSize = (fmt, res) => {
    const [aw, ah] = ASPECTS[fmt];
    return aw < ah ? [res, Math.round(res * ah / aw / 2) * 2] : [Math.round(res * aw / ah / 2) * 2, res];
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
    $('#logoOn').checked = s.logo;
    $$('.range').forEach(setRangeFill);
    updateDerived();
  }

  function updateDerived() {
    const s = state.settings;
    const ids = { '9x16': '#dim916', '4x5': '#dim45', '1x1': '#dim11', '16x9': '#dim169' };
    for (const [fmt, id] of Object.entries(ids)) $(id).textContent = outSize(fmt, s.height).join('×');
    $$('.stage').forEach((st) => st.classList.toggle('off', !s.formats.includes(st.dataset.fmt)));
    const d = state.sel?.upload?.info?.duration;
    $('#sizeEst').textContent = d
      ? `≈ ${fmtBytes(s.bitrate * 1e6 / 8 * d)} на кожен файл (${fmtTime(d)})`
      : 'Для соцмереж 1080p достатньо 5–8 Мбіт/с';
    $('.asset-row').classList.toggle('off', !s.logo);
    updateOutNames();
    updateRenderBtn();
  }

  // Mirrors clean_name() in resizer.py so the preview shows the real file names.
  const cleanName = (n) => n.replace(/[<>:"/\\|?*\x00-\x1f]+/g, '_').replace(/\s+/g, ' ')
    .replace(/^[ .]+|[ .]+$/g, '').slice(0, 150) || 'video';
  function updateOutNames() {
    const el = $('#outNames');
    const it = state.sel;
    el.hidden = !it;
    if (!it) return;
    const n = cleanName(it.name);
    el.innerHTML = state.settings.formats.length
      ? 'Файли: ' + state.settings.formats.map((f) => `<b>${f}_${esc(n)}.mp4</b>`).join(', ')
      : 'Виберіть хоча б один формат';
  }

  const itemStatus = (it) => it.job ? it.job.status : it.state;
  const renderable = (it) => it.upload && !it.job;

  function updateRenderBtn() {
    const n = state.items.filter(renderable).length;
    const active = state.items.some((it) => ACTIVE.includes(itemStatus(it)));
    $('#renderBtn').disabled = !n || !state.settings.formats.length;
    $('#renderLbl').textContent = n ? `Рендерити все (${n})` : active ? 'Рендеринг…' : 'Рендерити все';
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
  $('#logoOn').addEventListener('change', (e) => {
    state.settings.logo = e.target.checked; persist(); updateDerived(); drawOnce();
  });

  // ---------------------------------------------------------------- logo & packshot
  const logoImg = new Image();
  logoImg.addEventListener('load', () => drawOnce());
  const pkVideo = $('#pkVideo');
  pkVideo.addEventListener('seeked', () => { if (video.paused) drawOnce(); });

  async function loadAssets() {
    try {
      const r = await fetch('/api/assets');
      if (r.ok) applyAssets(await r.json());
    } catch (_) {}
  }

  function applyAssets(a) {
    if (!a || a.error) return;
    const prevPk = state.assets?.packshot?.url;
    state.assets = a;
    if (logoImg.getAttribute('src') !== a.logo.url) logoImg.src = a.logo.url;
    $('#logoThumb').src = a.logo.url;
    $('#logoReset').hidden = !a.logo.custom;
    const pk = a.packshot;
    $('#pkPick').hidden = !!pk;
    $('#pkBox').hidden = !pk;
    $('#pkHint').textContent = pk ? `з'являється за ${a.fade_frames} кадрів` : '';
    if (pk) {
      $('#pkName').textContent = pk.name;
      const i = pk.info;
      $('#pkInfo').textContent = `${i.width}×${i.height} · ${fmtTime(i.vduration)}`
        + (i.width > i.height ? ' · не вертикальний — буде обрізаний' : '');
    }
    if (pk?.url !== prevPk) {
      if (pk) { pkVideo.src = pk.url; pkVideo.load(); } else { pkVideo.removeAttribute('src'); pkVideo.load(); }
    }
    updateAll();
    drawOnce();
  }

  async function uploadAsset(url, file, busyEl) {
    if (!file) return;
    busyEl.classList.add('busy');
    try {
      const r = await fetch(url, { method: 'POST', headers: { 'X-Filename': encodeURIComponent(file.name) }, body: file });
      const res = await r.json();
      if (!r.ok) toast(res.error || 'Не вдалося завантажити файл');
      else applyAssets(res);
    } catch (_) { toast('Сервер недоступний'); }
    busyEl.classList.remove('busy');
  }
  const bindAssetInput = (sel, url, busySel) => $(sel).addEventListener('change', (e) => {
    const f = e.target.files[0]; e.target.value = '';
    uploadAsset(url, f, $(busySel));
  });
  bindAssetInput('#logoInput', '/api/assets/logo', '.asset-row .btn');
  bindAssetInput('#pkInput', '/api/assets/packshot', '#pkPick');
  bindAssetInput('#pkReplace', '/api/assets/packshot', '#pkBox');
  const postAsset = async (url) => {
    try { applyAssets(await (await fetch(url, { method: 'POST' })).json()); } catch (_) { toast('Сервер недоступний'); }
  };
  $('#logoReset').addEventListener('click', () => postAsset('/api/assets/logo/reset'));
  $('#pkRemove').addEventListener('click', () => postAsset('/api/assets/packshot/delete'));

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
      state.outputDir = info.output_dir || '';
      state.ffmpegReady = info.ffmpeg_ready !== false;
      showSetup(info);
      if (!state.ffmpegReady) {
        const chip = $('#encChip');
        chip.className = 'chip chip-warn';
        chip.lastElementChild.textContent = 'ffmpeg не встановлено';
        return;
      }
      fillEncoderSelect();
      loadAssets();
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

  // ---------------------------------------------------------------- ffmpeg setup
  const LOCK = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>';
  const INFO = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/></svg>';
  let setupInfo = null;
  let setupTimer = 0;

  function showSetup(info) {
    setupInfo = info;
    const ready = info.ffmpeg_ready !== false;
    $('#setup').hidden = ready;
    drop.hidden = !ready;
    if (ready) { clearTimeout(setupTimer); return; }
    const note = $('#setupNote');
    const btn = $('#setupBtn');
    if (!info.can_install) {
      note.innerHTML = `${INFO}<div>Встановіть ffmpeg і натисніть «Перевірити ще раз».
        <small>Windows: <b>winget install Gyan.FFmpeg</b> · Linux: <b>sudo apt install ffmpeg</b></small></div>`;
      btn.textContent = 'Перевірити ще раз';
    } else if (info.has_brew) {
      note.innerHTML = `${INFO}<div>Встановимо через Homebrew, який у вас уже є. Пароль не знадобиться.
        <small>Займе кілька хвилин — прогрес видно тут.</small></div>`;
      btn.textContent = 'Встановити ffmpeg';
    } else {
      note.innerHTML = `${LOCK}<div><b>Зараз macOS попросить пароль вашого Mac</b> — він потрібен, щоб встановити
        Homebrew (стандартний менеджер програм для macOS) і через нього ffmpeg.
        <small>Встановлення відкриється в Терміналі. Символи пароля там не відображаються під час введення — це нормально.
        Займе 5–15 хвилин; Resizer продовжить сам, щойно ffmpeg з'явиться.</small></div>`;
      btn.textContent = 'Встановити ffmpeg';
    }
    // Resume after a page reload while the install is still going.
    fetch('/api/setup').then((r) => r.json()).then(renderSetup).catch(() => {});
  }

  function renderSetup(st) {
    const running = st.status === 'running';
    state.setupRunning = running;
    $('#setupProgress').hidden = !running;
    $('#setupBtn').hidden = running;
    $('#setupErr').hidden = st.status !== 'error';
    $('#setupErr').textContent = st.error || '';
    if (st.status === 'error') $('#setupBtn').textContent = 'Спробувати ще раз';
    $('#setupLine').textContent = st.mode === 'terminal'
      ? 'Встановлення йде в Терміналі — введіть пароль, коли попросить…'
      : st.line || 'Починаю…';
    updateAll();
    clearTimeout(setupTimer);
    if (running) setupTimer = setTimeout(pollSetup, st.mode === 'terminal' ? 3000 : 1000);
  }

  async function pollSetup() {
    try {
      // ffmpeg installed in Terminal is noticed by /api/info; the in-app install reports via /api/setup.
      const st = await (await fetch('/api/setup')).json();
      if (st.status === 'done' || (st.mode === 'terminal' && (await (await fetch('/api/info')).json()).ffmpeg_ready)) {
        state.setupRunning = false;
        await loadInfo();
        updateAll();
        return;
      }
      renderSetup(st);
    } catch (_) { setupTimer = setTimeout(pollSetup, 3000); }
  }

  $('#setupBtn').addEventListener('click', async () => {
    if (!setupInfo?.can_install) { loadInfo(); return; }
    try {
      const st = await (await fetch('/api/setup/ffmpeg', { method: 'POST' })).json();
      renderSetup(st);
    } catch (_) { toast('Сервер недоступний'); }
  });

  // ---------------------------------------------------------------- add files
  const drop = $('#drop');
  const fileInput = $('#fileInput');
  ['dragenter', 'dragover'].forEach((ev) => document.addEventListener(ev, (e) => {
    e.preventDefault(); drop.classList.add('over');
  }));
  ['dragleave', 'drop'].forEach((ev) => document.addEventListener(ev, (e) => {
    e.preventDefault();
    if (ev === 'drop' || e.target === document.documentElement || !e.relatedTarget) drop.classList.remove('over');
  }));
  document.addEventListener('drop', (e) => addFiles(e.dataTransfer?.files || []));
  fileInput.addEventListener('change', () => { addFiles(fileInput.files); fileInput.value = ''; });

  let seq = 0;
  function addFiles(files) {
    if (state.ffmpegReady === false) { if (files.length) toast('Спершу встановіть ffmpeg'); return; }
    for (const f of files) {
      state.items.push({
        key: ++seq, file: f, name: f.name.replace(/\.[^.]+$/, ''), packshot: true,
        state: 'waiting', pct: 0, upload: null, job: null, el: null,
      });
    }
    if (!files.length) return;
    renderQueue();
    pumpUploads();
  }

  // Uploads go one at a time so the first video is ready to preview as soon as possible.
  let uploading = null;
  function pumpUploads() {
    if (uploading) return;
    const it = state.items.find((x) => x.state === 'waiting');
    if (!it) return;
    uploading = it;
    it.state = 'uploading';
    const xhr = new XMLHttpRequest();
    it.xhr = xhr;
    xhr.open('POST', '/api/upload');
    xhr.setRequestHeader('X-Filename', encodeURIComponent(it.file.name));
    xhr.upload.onprogress = (e) => {
      if (!e.lengthComputable) return;
      it.pct = e.loaded / e.total;
      updateRow(it);
    };
    const done = (error, res) => {
      uploading = null;
      it.xhr = null;
      if (error) {
        toast(`${it.file.name}: ${error}`);
        it.state = 'failed';
        removeItem(it);
      } else {
        it.upload = res; it.state = 'ready'; it.file = null;
        if (!state.sel || state.sel === it) selectItem(it);
        updateAll();
      }
      pumpUploads();
    };
    xhr.onload = () => {
      let res = {};
      try { res = JSON.parse(xhr.responseText); } catch (_) {}
      if (xhr.status !== 200) done(res.error || 'не вдалося завантажити файл');
      else done(null, res);
    };
    xhr.onerror = () => done('помилка завантаження');
    xhr.onabort = () => { uploading = null; it.xhr = null; pumpUploads(); };
    updateRow(it);
    xhr.send(it.file);
  }

  // ---------------------------------------------------------------- queue list
  const PENCIL = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16z"/><path d="m13.5 6.5 4 4"/></svg>';

  function buildRow(it) {
    const li = document.createElement('li');
    li.className = 'q-item';
    li.innerHTML = `<div class="q-meta">
        <label class="name-edit"><input type="text" spellcheck="false" autocomplete="off" aria-label="Назва файлів" placeholder="Назва файлу">${PENCIL}</label>
        <div class="file-tags"></div>
        <div class="bar"><span></span></div>
      </div>
      <label class="q-pk" title="Накласти пекшот на кінець цього відео"><input type="checkbox" checked> Пекшот</label>
      <span class="q-status"></span>
      <button class="icon-btn q-retry" type="button" title="Рендерити ще раз" aria-label="Рендерити ще раз">↻</button>
      <button class="icon-btn q-remove" type="button">✕</button>`;
    const input = li.querySelector('input');
    input.value = it.name;
    input.addEventListener('input', () => { it.name = input.value; if (state.sel === it) updateOutNames(); });
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') input.blur(); });
    li.addEventListener('click', (e) => { if (!e.target.closest('button')) selectItem(it); });
    const retry = li.querySelector('.q-retry');
    retry.addEventListener('click', () => {
      it.job = null;
      if (state.sel === it) selectItem(it);
      updateAll();
    });
    const remove = li.querySelector('.q-remove');
    remove.addEventListener('click', () => removeItem(it));
    const pkLabel = li.querySelector('.q-pk');
    const pk = pkLabel.querySelector('input');
    pk.addEventListener('change', () => { it.packshot = pk.checked; if (state.sel === it) drawOnce(); });
    it.el = {
      li, input, retry, remove, pkLabel, pk, tags: li.querySelector('.file-tags'), bar: li.querySelector('.bar'),
      fill: li.querySelector('.bar span'), status: li.querySelector('.q-status'), tagged: false,
    };
  }

  function renderQueue() {
    const list = $('#queueList');
    for (const it of state.items) {
      if (!it.el) buildRow(it);
      list.append(it.el.li);       // keeps the order, moves nothing that is already in place
    }
    $('#queueWrap').hidden = !state.items.length;
    drop.classList.toggle('compact', state.items.length > 0);
    $('#dropTitle').textContent = state.items.length ? 'Додати ще відео' : 'Перетягніть вертикальні відео';
    updateAll();
  }

  function updateRow(it) {
    const el = it.el;
    if (!el) return;
    const st = itemStatus(it);
    const job = it.job;
    el.li.classList.toggle('sel', state.sel === it);
    const text = {
      waiting: 'очікує', uploading: `завантаження ${Math.floor(it.pct * 100)}%`, ready: 'готове до рендеру',
      queued: 'в черзі', running: job ? `${Math.floor(job.progress * 100)}% · ${fmtTime(job.eta)}` : '',
      done: job ? `✓ готово за ${fmtTime(job.elapsed)}` : '', error: 'помилка', cancelled: 'скасовано',
    }[st] || st;
    el.status.textContent = text;
    el.status.className = 'q-status' + (st === 'done' ? ' done' : st === 'error' ? ' error' : '');
    el.bar.hidden = !(st === 'uploading' || st === 'running');
    el.fill.style.width = ((st === 'uploading' ? it.pct : job?.progress || 0) * 100).toFixed(1) + '%';
    el.input.disabled = !!job;     // the name is used when the render starts
    el.pkLabel.hidden = !state.assets?.packshot;
    el.pk.disabled = !!job;
    el.retry.hidden = !(job && !ACTIVE.includes(st));
    const cancel = ACTIVE.includes(st);
    el.remove.title = cancel ? 'Скасувати рендер' : 'Прибрати з черги';
    el.remove.setAttribute('aria-label', el.remove.title);
    if (it.upload && !el.tagged) {
      const i = it.upload.info;
      const tags = [
        `${i.width}×${i.height}`, fmtTime(i.duration), i.fps ? `${i.fps} fps` : null,
        (i.video_codec || '').toUpperCase(), fmtBytes(i.size),
      ].filter(Boolean).map((t) => `<span class="tag">${esc(t)}</span>`);
      if (i.width > i.height) tags.push('<span class="tag warn">Не вертикальне — буде вписане в кадр</span>');
      el.tags.innerHTML = tags.join('');
      el.tagged = true;
    }
  }

  async function removeItem(it) {
    const st = itemStatus(it);
    if (ACTIVE.includes(st)) {
      // First click cancels the render; the item stays as "cancelled" and can be removed then.
      await fetch(`/api/jobs/${it.job.id}/cancel`, { method: 'POST' }).catch(() => {});
      poll();
      return;
    }
    if (it.xhr) it.xhr.abort();
    if (it.upload) fetch(`/api/uploads/${it.upload.id}/delete`, { method: 'POST' }).catch(() => {});
    const idx = state.items.indexOf(it);
    if (idx < 0) return;
    state.items.splice(idx, 1);
    state.batch = state.batch.filter((x) => x !== it);
    it.el?.li.remove();
    if (state.sel === it) selectItem(state.items[idx] || state.items[idx - 1] || null);
    renderQueue();
  }

  function selectItem(it) {
    state.sel = it;
    if (it?.upload) setupPreview(it.upload.url);
    else { $('#previewWrap').hidden = true; video.pause(); }
    if (it?.job?.status === 'done') showResults(it);
    else $('#results').hidden = true;
    updateAll();
    updateDerived();
  }

  // ---------------------------------------------------------------- preview
  const video = $('#srcVideo');
  const canvases = { '9x16': $('#cv916'), '4x5': $('#cv45'), '1x1': $('#cv11'), '16x9': $('#cv169') };
  const ctxs = {};
  let raf = 0;
  let previewUrl = '';

  // Blurred background, computed once per frame for all formats. Done by hand instead of
  // ctx.filter because WebKit (the macOS app window) accepts ctx.filter but ignores it.
  const tiny = document.createElement('canvas');
  const tinyCtx = tiny.getContext('2d', { willReadFrequently: true });
  function sizeCanvases() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    for (const [fmt, cv] of Object.entries(canvases)) {
      const [aw, ah] = ASPECTS[fmt];
      const w = Math.max(2, Math.round(cv.clientWidth * dpr));
      const h = Math.round(w * ah / aw);
      if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
      ctxs[fmt] = cv.getContext('2d');
    }
    drawOnce();
  }
  window.addEventListener('resize', sizeCanvases);

  function setupPreview(url) {
    $('#previewWrap').hidden = false;
    if (url === previewUrl) { requestAnimationFrame(sizeCanvases); return; }
    previewUrl = url;
    video.pause();
    video.src = url;
    video.currentTime = 0;
    video.addEventListener('loadeddata', () => { sizeCanvases(); drawOnce(); }, { once: true });
    requestAnimationFrame(sizeCanvases);
    setPlaying(false);
  }

  // Box blur (radius r, `passes` times) over RGBA pixels, rows then columns — like ffmpeg's boxblur.
  function boxBlur(px, w, h, r, passes) {
    const tmp = new Uint8ClampedArray(px.length);
    const line = (src, dst, n, start, step) => {
      const win = 2 * r + 1;
      for (let c = 0; c < 3; c++) {
        let sum = 0;
        for (let k = -r; k <= r; k++) sum += src[start + Math.min(n - 1, Math.max(0, k)) * step + c];
        for (let i = 0; i < n; i++) {
          dst[start + i * step + c] = sum / win;
          sum += src[start + Math.min(n - 1, i + r + 1) * step + c] - src[start + Math.max(0, i - r) * step + c];
        }
      }
    };
    for (let p = 0; p < passes; p++) {
      for (let y = 0; y < h; y++) line(px, tmp, w, y * w * 4, 4);
      for (let x = 0; x < w; x++) line(tmp, px, h, x * 4, w * 4);
    }
  }

  // Mirrors the ffmpeg graph: shrink to BG_WORK_WIDTH, blur, darken; draw() then crops and upscales.
  function blurredBackground(src) {
    const vw = video.videoWidth, vh = video.videoHeight;
    const w = BG_WORK_WIDTH, h = Math.max(2, Math.round(w * vh / vw / 2) * 2);
    if (tiny.width !== w || tiny.height !== h) { tiny.width = w; tiny.height = h; }
    tinyCtx.drawImage(src, 0, 0, w, h);
    const img = tinyCtx.getImageData(0, 0, w, h);
    const s = state.settings;
    boxBlur(img.data, w, h, 1 + Math.round(s.blur / 100 * 11), 2);
    const level = 1 - s.dim / 100;
    const px = img.data;
    for (let i = 0; i < px.length; i += 4) { px[i] *= level; px[i + 1] *= level; px[i + 2] *= level; }
    tinyCtx.putImageData(img, 0, 0);
    return { w, h };
  }

  function draw(fmt, bg, frame) {
    const ctx = ctxs[fmt]; const cv = canvases[fmt];
    if (!ctx || !video.videoWidth) return;
    const W = cv.width, H = cv.height, vw = video.videoWidth, vh = video.videoHeight;

    // Background: cover-crop the blurred tiny frame to the output aspect, then upscale.
    let cw = bg.w, ch = Math.round(cw * H / W);
    if (ch > bg.h) { ch = bg.h; cw = Math.round(ch * W / H); }
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(tiny, (bg.w - cw) / 2, (bg.h - ch) / 2, cw, ch, 0, 0, W, H);

    // Foreground: fitted, centered.
    const fit = Math.min(W / vw, H / vh);
    const fw = vw * fit, fh = vh * fit;
    ctx.drawImage(frame.img, (W - fw) / 2, (H - fh) / 2, fw, fh);

    // Logo: under the packshot, so it fades out while the packshot fades in (as in the render).
    const r = logoRect(fmt);
    if (r && frame.alpha < 1) {
      ctx.globalAlpha = 1 - frame.alpha;
      ctx.drawImage(logoImg, r.x, r.y, r.w, r.h);
      ctx.globalAlpha = 1;
    }
    if (r && (hover === fmt || drag?.fmt === fmt)) {
      const dpr = W / cv.clientWidth;
      ctx.save();
      ctx.strokeStyle = 'rgba(255,255,255,.9)'; ctx.lineWidth = dpr; ctx.setLineDash([4 * dpr, 3 * dpr]);
      ctx.strokeRect(r.x, r.y, r.w, r.h);
      ctx.setLineDash([]); ctx.fillStyle = '#fff';
      const hs = HANDLE * dpr;
      ctx.fillRect(r.x + r.w - hs / 2, r.y + r.h - hs / 2, hs, hs);
      ctx.restore();
    }
  }

  // ---- packshot in the preview: same timing as the render (ends with the video, fades in over N frames)
  const mix = document.createElement('canvas');
  const mixCtx = mix.getContext('2d');
  function packshotAlpha() {
    const pk = state.assets?.packshot;
    const info = state.sel?.upload?.info;
    if (!pk || !info || !state.sel.packshot || !pkVideo.videoWidth) return { alpha: 0 };
    const dur = info.vduration || info.duration || video.duration || 0;
    const t0 = Math.max(0, dur - pk.info.vduration);
    const fade = state.assets.fade_frames / (info.fps || 30);
    const t = video.currentTime;
    return { alpha: Math.max(0, Math.min(1, (t - t0) / fade)), target: Math.max(0, t - t0), on: t >= t0 };
  }
  function syncPackshot(p) {
    if (!p.on) { if (!pkVideo.paused) pkVideo.pause(); return; }
    const drift = Math.abs(pkVideo.currentTime - p.target);
    if (video.paused) {
      if (!pkVideo.paused) pkVideo.pause();
      if (drift > 0.03) pkVideo.currentTime = p.target;
    } else {
      if (drift > 0.25) pkVideo.currentTime = p.target;
      if (pkVideo.paused) pkVideo.play().catch(() => {});
    }
  }
  function frameSource() {
    const p = packshotAlpha();
    if (state.assets?.packshot) syncPackshot(p);
    if (!p.alpha) return { img: video, alpha: 0 };
    // Source frame with the packshot on top, cover-cropped like ffmpeg's scale+crop.
    const vw = video.videoWidth, vh = video.videoHeight;
    const k = Math.min(1, 1280 / vh);
    const w = Math.round(vw * k), h = Math.round(vh * k);
    if (mix.width !== w || mix.height !== h) { mix.width = w; mix.height = h; }
    mixCtx.globalAlpha = 1;
    mixCtx.drawImage(video, 0, 0, w, h);
    const pw = pkVideo.videoWidth, ph = pkVideo.videoHeight;
    const s = Math.max(w / pw, h / ph);
    mixCtx.globalAlpha = p.alpha;
    mixCtx.drawImage(pkVideo, (w - pw * s) / 2, (h - ph * s) / 2, pw * s, ph * s);
    mixCtx.globalAlpha = 1;
    return { img: mix, alpha: p.alpha };
  }

  function drawOnce() {
    if (video.videoWidth) {
      const frame = frameSource();
      const bg = blurredBackground(frame.img);
      Object.keys(canvases).forEach((fmt) => draw(fmt, bg, frame));
    }
    updateTime();
  }

  // ---- logo placement: drag to move, bottom-right handle to resize; saved per format
  const HANDLE = 10;          // handle size, CSS px
  let hover = null;           // format whose canvas the pointer is over
  let drag = null;            // {fmt, mode: 'move'|'resize', x0, y0, pos0}
  const logoPos = (fmt) => state.assets?.logo_pos?.[fmt];
  function logoRect(fmt) {
    const p = logoPos(fmt);
    if (!state.settings.logo || !p || !logoImg.naturalWidth) return null;
    const cv = canvases[fmt];
    const w = p.w * cv.width;
    return { x: p.x * cv.width, y: p.y * cv.height, w, h: w * logoImg.naturalHeight / logoImg.naturalWidth };
  }
  function hitTest(fmt, e) {
    const r = logoRect(fmt);
    if (!r) return null;
    const cv = canvases[fmt];
    const k = cv.width / cv.clientWidth;
    const x = e.offsetX * k, y = e.offsetY * k, h = HANDLE * k;
    if (Math.abs(x - (r.x + r.w)) <= h && Math.abs(y - (r.y + r.h)) <= h) return 'resize';
    if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) return 'move';
    return null;
  }
  let saveTimer = 0;
  function saveLogoPos(fmt) {
    clearTimeout(saveTimer);
    const body = JSON.stringify({ [fmt]: logoPos(fmt) });
    saveTimer = setTimeout(() => fetch('/api/logo-pos', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body,
    }).catch(() => toast('Не вдалося зберегти позицію лого')), 150);
  }
  for (const [fmt, cv] of Object.entries(canvases)) {
    cv.addEventListener('pointerdown', (e) => {
      const mode = hitTest(fmt, e);
      if (!mode) return;
      e.preventDefault();
      cv.setPointerCapture(e.pointerId);
      drag = { fmt, mode, x0: e.offsetX, y0: e.offsetY, pos0: { ...logoPos(fmt) } };
    });
    cv.addEventListener('pointermove', (e) => {
      if (drag?.fmt === fmt) {
        const p = logoPos(fmt), p0 = drag.pos0;
        const dx = (e.offsetX - drag.x0) / cv.clientWidth, dy = (e.offsetY - drag.y0) / cv.clientHeight;
        const aspect = logoImg.naturalHeight / logoImg.naturalWidth * cv.width / cv.height;  // logo h / frame h per unit w
        if (drag.mode === 'move') {
          p.x = Math.max(0, Math.min(1 - p.w, p0.x + dx));
          p.y = Math.max(0, Math.min(1 - p.w * aspect, p0.y + dy));
        } else {
          const maxW = Math.min(1 - p0.x, (1 - p0.y) / aspect);
          p.w = Math.max(0.03, Math.min(maxW, p0.w + dx));
        }
        if (video.paused) drawOnce();
        return;
      }
      const mode = hitTest(fmt, e);
      cv.style.cursor = mode === 'resize' ? 'nwse-resize' : mode === 'move' ? 'move' : '';
      // Outline the logo while the pointer is over its frame, so it is clear it can be moved.
      if (hover !== fmt) { hover = fmt; if (video.paused) drawOnce(); }
    });
    const end = () => {
      if (drag?.fmt !== fmt) return;
      drag = null;
      saveLogoPos(fmt);
      if (video.paused) drawOnce();
    };
    cv.addEventListener('pointerup', end);
    cv.addEventListener('pointercancel', end);
    cv.addEventListener('pointerleave', () => { if (hover === fmt && !drag) { hover = null; if (video.paused) drawOnce(); } });
  }
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
  video.addEventListener('pause', () => { setPlaying(false); pkVideo.pause(); drawOnce(); });
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
    const todo = state.items.filter(renderable);
    if (!todo.length || !state.settings.formats.length) return;
    video.pause();
    // A new run starts a new progress batch; items added during a run join it.
    if (!state.batch.some((it) => ACTIVE.includes(itemStatus(it)))) state.batch = [];
    $('#renderBtn').disabled = true;
    for (const it of todo) {
      const body = {
        id: it.upload.id, name: cleanName(it.name), ...state.settings,
        packshot: !!state.assets?.packshot && it.packshot,
      };
      try {
        const r = await fetch('/api/render', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
        });
        const job = await r.json();
        if (!r.ok) { toast(`${it.upload.name}: ${job.error || 'не вдалося запустити рендер'}`); continue; }
        it.job = job;
        state.batch.push(it);
      } catch (_) { toast('Сервер недоступний'); break; }
    }
    updateAll();
    poll();
  });

  $('#cancelBtn').addEventListener('click', async () => {
    await fetch('/api/cancel-all', { method: 'POST' }).catch(() => {});
    poll();
  });

  function poll() {
    clearTimeout(state.pollTimer);
    const tick = async () => {
      try {
        const jobs = await (await fetch('/api/jobs')).json();
        const byId = new Map(jobs.map((j) => [j.id, j]));
        for (const it of state.items) {
          if (!it.job) continue;
          const prev = it.job.status;
          const job = byId.get(it.job.id);
          if (job) it.job = job;
          else if (ACTIVE.includes(prev)) it.job = { ...it.job, status: 'error', error: 'Рендер втрачено: сервер перезапустився' };
          if (it === state.sel && it.job.status === 'done' && prev !== 'done') showResults(it);
        }
        updateAll();
        if (state.items.some((it) => ACTIVE.includes(itemStatus(it)))) state.pollTimer = setTimeout(tick, 500);
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

  let wasBusy = false;
  function updateAll() {
    state.items.forEach(updateRow);
    $('#queueHint').textContent = state.items.length ? `${state.items.length} відео` : '';
    updateJobBox();
    updateRenderBtn();
    const err = state.sel?.job?.status === 'error' ? state.sel.job.error : '';
    $('#jobErr').hidden = !err;
    $('#jobErr').textContent = err;
    // Tell the macOS app window whether closing it would cancel a render.
    const busy = state.setupRunning || state.items.some((it) => ACTIVE.includes(itemStatus(it)));
    if (busy !== wasBusy) {
      wasBusy = busy;
      try { window.webkit?.messageHandlers?.busy?.postMessage(busy); } catch (_) {}
    }
  }

  function updateJobBox() {
    const box = $('#jobBox');
    const b = state.batch;
    box.hidden = !b.length;
    if (!b.length) return;
    const st = b.map(itemStatus);
    const active = st.some((s) => ACTIVE.includes(s));
    const finished = st.filter((s) => !ACTIVE.includes(s)).length;
    const done = st.filter((s) => s === 'done').length;
    const failed = st.filter((s) => s === 'error').length;
    const running = b.find((it) => itemStatus(it) === 'running');
    const progress = b.reduce((sum, it, i) => sum + (!ACTIVE.includes(st[i]) ? 1 : it.job.progress || 0), 0) / b.length;

    box.classList.toggle('done', !active);
    $('#jobBar').style.width = (progress * 100).toFixed(1) + '%';
    $('#jobPct').textContent = Math.floor(progress * 100) + '%';
    if (active) {
      $('#jobStatus').textContent = b.length > 1 ? `Рендер ${Math.min(finished + 1, b.length)} з ${b.length}…` : 'Рендеринг…';
    } else {
      $('#jobStatus').textContent = `Готово ${done} з ${b.length}` + (failed ? ` · помилок: ${failed}` : '');
    }
    const speed = running?.job.speed || 0;
    $('#jobSpeed').textContent = speed ? speed.toFixed(1) + '×' : '—';
    // Time left = current file + the queued ones at the current speed.
    let eta = active ? 0 : null;
    if (running) eta = running.job.eta;
    if (active && eta != null) {
      const queued = b.filter((it) => itemStatus(it) === 'queued');
      if (queued.length) eta = speed ? eta + queued.reduce((s, it) => s + (it.upload.info.duration || 0), 0) / speed : null;
    }
    $('#jobEta').textContent = fmtTime(eta);
    const lastEnc = (running || [...b].reverse().find((it) => it.job?.encoder))?.job.encoder;
    $('#jobEnc').textContent = encLabel(lastEnc);
    $('#cancelBtn').hidden = !active;
  }

  function showResults(it) {
    const job = it.job;
    const grid = $('#resultGrid');
    grid.innerHTML = '';
    const single = job.outputs.length === 1;
    grid.classList.toggle('single', single);
    // Columns proportional to the aspect ratios, so all results line up at the same height.
    grid.style.gridTemplateColumns = single ? '' : job.outputs.map((o) => `minmax(0, ${(o.width / o.height).toFixed(3)}fr)`).join(' ');
    for (const o of job.outputs) {
      const el = document.createElement('div');
      el.className = 'result';
      const v = document.createElement('video');
      v.controls = true; v.preload = 'metadata'; v.playsInline = true;
      v.src = o.url + '?t=' + Date.now();
      v.style.aspectRatio = `${o.width} / ${o.height}`;
      const foot = document.createElement('div');
      foot.className = 'result-foot';
      foot.innerHTML = `<div class="result-info"><b>${o.label}</b>${o.width}×${o.height} · ${fmtBytes(o.size)}<div class="result-file"></div></div>`;
      foot.querySelector('.result-file').textContent = o.file;
      if (NATIVE) {
        // Files are already saved in the output folder; a download makes no sense in the app window.
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'btn btn-sm btn-dl';
        btn.textContent = 'Показати у Finder';
        btn.addEventListener('click', () => fetch('/api/reveal', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ file: o.file }),
        }));
        foot.append(btn);
      } else {
        const a = document.createElement('a');
        a.className = 'btn btn-sm btn-dl';
        a.href = o.url + '?download=1';
        a.download = o.file;
        a.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v11m0 0 4.5-4.5M12 15l-4.5-4.5"/><path d="M5 19h14"/></svg>Завантажити';
        foot.append(a);
      }
      el.append(v, foot);
      grid.append(el);
    }
    const folder = state.outputDir.split(/[\\/]/).filter(Boolean).pop() || 'output';
    $('#resultHint').textContent = `збережено в папці ${folder} · ${fmtTime(job.elapsed)}, ${encLabel(job.encoder)}`;
    $('#results').hidden = false;
  }

  $('#openFolder').addEventListener('click', () => fetch('/api/open-folder', { method: 'POST' }));

  // Keeps the local server alive while this tab is open (Resizer.app stops it when idle).
  setInterval(() => fetch('/api/ping').catch(() => {}), 15000);

  applySettingsToUI();
  loadInfo();
})();
