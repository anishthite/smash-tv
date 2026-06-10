// SMASH TV — plays videos from archive.org/details/@anish_thite as a continuous channel.

const UPLOADER_QUERY = 'uploader:anish*thite* AND mediatype:movies';
const SCRAPE = 'https://archive.org/services/search/v1/scrape';
const META   = id => `https://archive.org/metadata/${encodeURIComponent(id)}`;
const DL     = (id, name) => `https://archive.org/download/${encodeURIComponent(id)}/${encodeURIComponent(name)}`;

const CACHE_KEY = 'smashtv.playlist.v1';
const CACHE_TTL_MS = 1000 * 60 * 60 * 6; // 6h

const els = {
  video:    document.getElementById('player'),
  ch:       document.getElementById('ch'),
  title:    document.getElementById('title'),
  hud:      document.getElementById('hud'),
  static:   document.getElementById('static'),
  boot:     document.getElementById('bootmsg'),
  share:    document.getElementById('share'),
  shareLbl: document.getElementById('sharelabel'),
  scrub:    document.getElementById('scrub'),
  prevBtn:  document.getElementById('prev'),
  nextBtn:  document.getElementById('next'),
  bar:      document.getElementById('bar'),
  progress: document.getElementById('progress'),
  buffered: document.getElementById('buffered'),
  thumb:    document.getElementById('thumb'),
  tcur:     document.getElementById('tcur'),
  tdur:     document.getElementById('tdur'),
};

function fmtTime(s) {
  if (!isFinite(s) || s < 0) return '0:00';
  s = Math.floor(s);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = h ? String(m).padStart(2, '0') : String(m);
  const ss = String(sec).padStart(2, '0');
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

const state = {
  items: [],     // [{identifier, title}]
  order: [],     // index permutation
  pos: 0,
  shuffle: true,
  metaCache: new Map(), // id -> {url, title}
  hudTimer: null,
};

/* ---------- playlist ---------- */

async function loadPlaylist() {
  const cached = readCache();
  if (cached) return cached;

  const all = [];
  let cursor = null;
  // Scrape paginates with `cursor`. Pull everything; ~2.4k items.
  for (let i = 0; i < 100; i++) {
    const url = new URL(SCRAPE);
    url.searchParams.set('q', UPLOADER_QUERY);
    url.searchParams.set('fields', 'identifier,title,date');
    url.searchParams.set('count', '1000');
    if (cursor) url.searchParams.set('cursor', cursor);
    const r = await fetch(url);
    const j = await r.json();
    if (j.items) all.push(...j.items);
    if (!j.cursor) break;
    cursor = j.cursor;
  }
  writeCache(all);
  return all;
}

function readCache() {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const { ts, items } = JSON.parse(raw);
    if (Date.now() - ts > CACHE_TTL_MS) return null;
    return items;
  } catch { return null; }
}
function writeCache(items) {
  try { localStorage.setItem(CACHE_KEY, JSON.stringify({ ts: Date.now(), items })); } catch {}
}

/* ---------- resolve playable URL ---------- */

async function resolveItem(id) {
  if (state.metaCache.has(id)) return state.metaCache.get(id);
  const r = await fetch(META(id));
  const j = await r.json();
  const files = j.files || [];
  // Prefer h.264 IA derivative (small + universally playable), then any mp4.
  const ia    = files.find(f => /\.ia\.mp4$/i.test(f.name));
  const mp4   = ia || files.find(f => /\.mp4$/i.test(f.name));
  if (!mp4) return null;
  const out = {
    url: DL(id, mp4.name),
    title: (j.metadata && j.metadata.title) || id,
  };
  state.metaCache.set(id, out);
  return out;
}

/* ---------- playback ---------- */

function shuffleArr(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function setOrder() {
  const idx = state.items.map((_, i) => i);
  state.order = state.shuffle ? shuffleArr(idx) : idx;
  state.pos = 0;
}

async function playAt(pos, opts = {}) {
  if (!state.items.length) return;
  state.pos = (pos + state.order.length) % state.order.length;
  const item = state.items[state.order[state.pos]];
  state.pendingSeek = (typeof opts.startAt === 'number' && opts.startAt > 0) ? opts.startAt : 0;

  flashStatic();
  showHud(`CH ${String(state.pos + 1).padStart(3, '0')}`, 'tuning…');

  let resolved = null;
  // Skip up to 5 items if metadata or mp4 missing
  for (let tries = 0; tries < 5; tries++) {
    try {
      resolved = await resolveItem(item.identifier);
      if (resolved) break;
    } catch (e) { /* fall through */ }
    state.pos = (state.pos + 1) % state.order.length;
  }
  if (!resolved) { showHud('---', 'no playable item'); return; }

  els.video.src = resolved.url;
  els.video.play().catch(() => { /* autoplay may need a click; HUD will say so */ });
  showHud(`CH ${String(state.pos + 1).padStart(3, '0')}`, resolved.title);
  updateUrl(item.identifier);

  // Pre-warm next item's metadata
  const nextItem = state.items[state.order[(state.pos + 1) % state.order.length]];
  resolveItem(nextItem.identifier).catch(() => {});
}

function next() { playAt(state.pos + 1); }
function prev() { playAt(state.pos - 1); }

/* ---------- url params + share ---------- */

function parseUrlParams() {
  const p = new URLSearchParams(location.search);
  const v = p.get('v');
  let t = 0;
  const traw = p.get('t');
  if (traw) {
    // Accept '90', '90s', '1m30s', '1:30', '1:02:03'
    const m1 = /^(\d+)s?$/.exec(traw);
    const m2 = /^(?:(\d+)m)?(?:(\d+)s?)?$/.exec(traw);
    const m3 = /^(?:(\d+):)?(\d+):(\d+)$/.exec(traw);
    if (m3) t = (+(m3[1]||0))*3600 + (+m3[2])*60 + (+m3[3]);
    else if (m1) t = +m1[1];
    else if (m2 && (m2[1] || m2[2])) t = (+(m2[1]||0))*60 + (+(m2[2]||0));
    else t = parseFloat(traw) || 0;
  }
  return { v, t };
}

function updateUrl(identifier) {
  const u = new URL(location.href);
  u.searchParams.set('v', identifier);
  u.searchParams.delete('t');
  history.replaceState(null, '', u);
}

function shareUrl() {
  const item = state.items[state.order[state.pos]];
  if (!item) return location.href;
  const u = new URL(location.href);
  u.searchParams.set('v', item.identifier);
  const t = Math.floor(els.video.currentTime || 0);
  if (t > 0) u.searchParams.set('t', String(t));
  else u.searchParams.delete('t');
  return u.toString();
}

async function onShareClick() {
  const url = shareUrl();
  let ok = false;
  try {
    await navigator.clipboard.writeText(url);
    ok = true;
  } catch {
    // Fallback: temp textarea
    try {
      const ta = document.createElement('textarea');
      ta.value = url; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      ok = document.execCommand('copy');
      document.body.removeChild(ta);
    } catch {}
  }
  flashShare(ok ? 'COPIED' : 'COPY FAIL');
}

function flashShare(msg) {
  const prev = els.shareLbl.textContent;
  els.shareLbl.textContent = msg;
  revealOverlays();
  clearTimeout(state.shareTimer);
  state.shareTimer = setTimeout(() => { els.shareLbl.textContent = 'SHARE'; }, 1400);
}

/* ---------- effects ---------- */

function flashStatic() {
  els.static.classList.remove('hidden');
  setTimeout(() => els.static.classList.add('hidden'), 350);
}

function showHud(ch, title) {
  els.ch.textContent = ch.replace(/^CH /, '');
  els.title.textContent = title;
  revealOverlays();
}

function revealOverlays() {
  els.hud.classList.remove('fade');
  els.scrub.classList.remove('fade');
  els.scrub.classList.add('active');
  clearTimeout(state.hudTimer);
  state.hudTimer = setTimeout(() => {
    els.hud.classList.add('fade');
    // Scrub bar stays visible-dim (CSS handles the dim state). Just drop the
    // 'active' boost so it returns to the resting opacity.
    els.scrub.classList.remove('active');
  }, 3500);
}

/* ---------- scrub bar ---------- */

function setupScrub() {
  const v = els.video;

  const updateProgress = () => {
    const dur = v.duration;
    if (isFinite(dur) && dur > 0) {
      const pct = (v.currentTime / dur) * 100;
      els.progress.style.width = pct + '%';
      els.thumb.style.left = pct + '%';
      els.tcur.textContent = fmtTime(v.currentTime);
      els.tdur.textContent = fmtTime(dur);
    } else {
      els.progress.style.width = '0%';
      els.thumb.style.left = '0%';
      els.tcur.textContent = '0:00';
      els.tdur.textContent = '0:00';
    }
  };
  const updateBuffered = () => {
    const dur = v.duration;
    if (!isFinite(dur) || dur <= 0 || !v.buffered.length) return;
    const end = v.buffered.end(v.buffered.length - 1);
    els.buffered.style.width = ((end / dur) * 100) + '%';
  };

  v.addEventListener('timeupdate', updateProgress);
  v.addEventListener('loadedmetadata', () => {
    updateProgress();
    if (state.pendingSeek > 0) {
      try { v.currentTime = Math.min(state.pendingSeek, (v.duration || state.pendingSeek)); } catch {}
      state.pendingSeek = 0;
    }
  });
  v.addEventListener('durationchange', updateProgress);
  v.addEventListener('progress', updateBuffered);
  v.addEventListener('emptied', () => { els.buffered.style.width = '0%'; });

  // Click/drag to seek
  const seekFromEvent = (e) => {
    const rect = els.bar.getBoundingClientRect();
    const x = Math.min(Math.max(e.clientX - rect.left, 0), rect.width);
    const pct = x / rect.width;
    if (isFinite(v.duration) && v.duration > 0) {
      v.currentTime = pct * v.duration;
    }
    revealOverlays();
  };
  let dragging = false;
  els.bar.addEventListener('mousedown', e => {
    dragging = true;
    seekFromEvent(e);
    e.preventDefault();
  });
  window.addEventListener('mousemove', e => { if (dragging) seekFromEvent(e); });
  window.addEventListener('mouseup',   () => { dragging = false; });

  // Any mouse movement re-reveals overlays briefly
  window.addEventListener('mousemove', revealOverlays);
}

/* ---------- input ---------- */

function setupKeys() {
  window.addEventListener('keydown', e => {
    switch (e.key) {
      case 'ArrowRight': next(); break;
      case 'ArrowLeft':  prev(); break;
      case ' ':
        e.preventDefault();
        if (els.video.paused) els.video.play(); else els.video.pause();
        break;
      case 'm': case 'M':
        els.video.muted = !els.video.muted;
        showHud(els.ch.textContent, els.video.muted ? '(muted)' : els.title.textContent);
        break;
      case 'f': case 'F':
        if (document.fullscreenElement) document.exitFullscreen();
        else document.documentElement.requestFullscreen();
        break;
      case 's': case 'S':
        state.shuffle = !state.shuffle;
        setOrder();
        showHud(els.ch.textContent, state.shuffle ? '(shuffle on)' : '(shuffle off)');
        break;
      case ',': case '<':
        els.video.currentTime = Math.max(0, els.video.currentTime - 5);
        revealOverlays();
        break;
      case '.': case '>':
        els.video.currentTime = Math.min((els.video.duration || 0), els.video.currentTime + 5);
        revealOverlays();
        break;
    }
  });

  // First user gesture: unmute + dismiss boot screen
  const arm = () => {
    els.boot.classList.add('hidden');
    els.video.muted = false;
    els.video.play().catch(() => {});
    window.removeEventListener('click', arm);
    window.removeEventListener('keydown', arm);
  };
  window.addEventListener('click', arm);
  window.addEventListener('keydown', arm);
}

/* ---------- bootstrap ---------- */

window.__smashtv = state;
(async function main() {
  setupKeys();
  setupScrub();
  els.share.addEventListener('click',   e => { e.stopPropagation(); onShareClick(); });
  els.prevBtn.addEventListener('click', e => { e.stopPropagation(); prev(); });
  els.nextBtn.addEventListener('click', e => { e.stopPropagation(); next(); });
  console.log('[smashtv] booting');
  els.video.addEventListener('ended', next);
  els.video.addEventListener('error', () => { console.warn('video error, skipping'); next(); });

  try {
    state.items = await loadPlaylist();
    console.log('[smashtv] playlist loaded', state.items.length);
  } catch (e) {
    console.error('[smashtv] playlist load failed', e);
    showHud('ERR', 'failed to load playlist: ' + e.message);
    return;
  }
  if (!state.items.length) { showHud('---', 'no videos found'); return; }
  setOrder();

  // Honor ?v=<identifier>&t=<seconds>
  const { v: wantId, t: wantT } = parseUrlParams();
  let startPos = 0;
  if (wantId) {
    const idx = state.items.findIndex(it => it.identifier === wantId);
    if (idx >= 0) {
      // Put requested item first in order so playAt(0) lands on it.
      const orderIdx = state.order.indexOf(idx);
      if (orderIdx > 0) {
        state.order.splice(orderIdx, 1);
        state.order.unshift(idx);
      }
    } else {
      // Not in playlist (private/new/etc) — inject it.
      state.items.unshift({ identifier: wantId, title: wantId });
      state.order = state.order.map(i => i + 1);
      state.order.unshift(0);
    }
  }
  playAt(startPos, { startAt: wantT });
})();
