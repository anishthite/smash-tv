// SMASH TV — plays videos from archive.org/details/@anish_thite as a continuous channel.

const UPLOADER_QUERY = 'uploader:anish*thite* AND mediatype:movies';
const SCRAPE = 'https://archive.org/services/search/v1/scrape';
const META   = id => `https://archive.org/metadata/${encodeURIComponent(id)}`;
const DL     = (id, name) => `https://archive.org/download/${encodeURIComponent(id)}/${encodeURIComponent(name)}`;

const CACHE_KEY = 'smashtv.playlist.v1';
const CACHE_TTL_MS = 1000 * 60 * 60 * 6; // 6h
const CRT_KEY = 'smashtv.crt.v1';

const els = {
  tv:       document.getElementById('tv'),
  video:    document.getElementById('player'),
  ch:       document.getElementById('ch'),
  title:    document.getElementById('title'),
  hud:      document.getElementById('hud'),
  static:   document.getElementById('static'),
  boot:     document.getElementById('bootmsg'),
  share:    document.getElementById('share'),
  shareLbl: document.getElementById('sharelabel'),
  crt:      document.getElementById('crt'),
  crtLbl:   document.getElementById('crtlabel'),
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

/* ---------- playlist ----------
   Streams pages from archive.org's scrape API. The first page (1000 items)
   resolves in ~1-3s; the parent gets it via onPage() and starts playback
   immediately. Subsequent pages are appended in the background so the rest of
   the catalog becomes navigable without blocking startup.
*/

async function loadPlaylistStreaming(onPage) {
  const cached = readCache();
  if (cached && cached.length) {
    // Cache is complete — hand the whole thing over in one shot.
    onPage(cached, true);
    return cached;
  }

  const all = [];
  let cursor = null;
  for (let i = 0; i < 100; i++) {
    const url = new URL(SCRAPE);
    url.searchParams.set('q', UPLOADER_QUERY);
    url.searchParams.set('fields', 'identifier,title,date');
    url.searchParams.set('count', '1000');
    if (cursor) url.searchParams.set('cursor', cursor);
    const r = await fetch(url);
    const j = await r.json();
    const items = Array.isArray(j.items) ? j.items : [];
    if (items.length) {
      all.push(...items);
      try { onPage(items, !j.cursor); } catch (e) { console.error('[smashtv] onPage threw', e); }
    }
    if (!j.cursor) break;
    cursor = j.cursor;
    // Write an incremental cache so a reload mid-fetch isn't a full restart.
    writeCache(all);
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

// Append newly-discovered items to state.items and tack their indices on the
// end of state.order (shuffled among themselves if shuffle is on). Preserves
// the currently-playing position so streaming pages don't disrupt playback.
function appendItems(newItems) {
  if (!newItems || !newItems.length) return;
  const startIdx = state.items.length;
  for (const it of newItems) state.items.push(it);
  const newIdx = [];
  for (let i = startIdx; i < state.items.length; i++) newIdx.push(i);
  if (state.shuffle) shuffleArr(newIdx);
  state.order.push(...newIdx);
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
  // CSS hides the static layer entirely when CRT is off, but skip the
  // setTimeout dance too — nothing to reveal.
  if (els.tv.classList.contains('crt-off')) return;
  els.static.classList.remove('hidden');
  setTimeout(() => els.static.classList.add('hidden'), 350);
}

/* ---------- CRT toggle ----------
   Single user-facing setting so far. Persisted in localStorage; restored on
   boot. The actual visual changes (hide scanlines/vignette, suppress static
   flash) are handled by the #tv.crt-off CSS class.
*/
function applyCrt(on) {
  els.tv.classList.toggle('crt-off', !on);
  if (els.crtLbl) els.crtLbl.textContent = on ? 'CRT ON' : 'CRT OFF';
  if (els.crt) els.crt.classList.toggle('off', !on);
}
function loadCrt() {
  let on = true;
  try { if (localStorage.getItem(CRT_KEY) === '0') on = false; } catch {}
  applyCrt(on);
}
function toggleCrt() {
  const nowOn = els.tv.classList.contains('crt-off'); // currently off -> turn on
  applyCrt(nowOn);
  try { localStorage.setItem(CRT_KEY, nowOn ? '1' : '0'); } catch {}
  revealOverlays();
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

/* ---------- touch input ----------
   Phones / tablets: swipe horizontally to change channel, tap to toggle play,
   double-tap to fullscreen. Vertical swipes are ignored (let the OS keep its
   gestures). The scrub bar handles its own touch events via the existing
   mouse handlers — we explicitly skip touches that land inside the scrub /
   HUD chrome so swipes don't fight buttons.
*/
function setupTouch() {
  const SWIPE_MIN_DX = 50;     // px horizontal to count as a swipe
  const SWIPE_MAX_DY = 60;     // px vertical tolerance — above this it's a scroll
  const TAP_MAX_DIST = 10;     // px movement still counts as a tap
  const TAP_MAX_MS   = 300;
  const DOUBLE_TAP_MS = 320;

  let sx = 0, sy = 0, st = 0, tracking = false, lastTapAt = 0;
  let singleTapTimer = null;

  const inChrome = (target) => {
    // Skip the scrub bar and HUD — they have their own controls.
    return !!(target.closest && (target.closest('#scrub') || target.closest('#hud')));
  };
  const bootVisible = () => !els.boot.classList.contains('hidden');

  els.video.parentElement.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1) { tracking = false; return; }
    if (inChrome(e.target)) { tracking = false; return; }
    // While the boot overlay is up, let arm() handle the tap; don't queue our
    // own play-toggle on top of it.
    if (bootVisible()) { tracking = false; return; }
    const t = e.touches[0];
    sx = t.clientX; sy = t.clientY; st = e.timeStamp;
    tracking = true;
  }, { passive: true });

  els.video.parentElement.addEventListener('touchend', (e) => {
    if (!tracking) return;
    tracking = false;
    const t = (e.changedTouches && e.changedTouches[0]) || null;
    if (!t) return;
    const dx = t.clientX - sx;
    const dy = t.clientY - sy;
    const dt = e.timeStamp - st;

    // Horizontal swipe — change channel.
    if (Math.abs(dx) > SWIPE_MIN_DX && Math.abs(dy) < SWIPE_MAX_DY) {
      if (singleTapTimer) { clearTimeout(singleTapTimer); singleTapTimer = null; }
      if (dx < 0) next(); else prev();
      return;
    }

    // Tap.
    if (Math.abs(dx) < TAP_MAX_DIST && Math.abs(dy) < TAP_MAX_DIST && dt < TAP_MAX_MS) {
      const now = e.timeStamp;
      if (now - lastTapAt < DOUBLE_TAP_MS) {
        // Double tap — toggle fullscreen.
        lastTapAt = 0;
        if (singleTapTimer) { clearTimeout(singleTapTimer); singleTapTimer = null; }
        if (document.fullscreenElement) document.exitFullscreen();
        else if (els.video.parentElement.requestFullscreen) els.video.parentElement.requestFullscreen();
        else if (els.video.webkitEnterFullscreen) els.video.webkitEnterFullscreen(); // iOS
        return;
      }
      lastTapAt = now;
      // Delay single-tap action so a double-tap can preempt it.
      singleTapTimer = setTimeout(() => {
        singleTapTimer = null;
        if (els.video.paused) els.video.play().catch(() => {});
        else els.video.pause();
        revealOverlays();
      }, DOUBLE_TAP_MS);
    }
  }, { passive: true });

  // Any touch should also wake the overlays.
  els.video.parentElement.addEventListener('touchmove', revealOverlays, { passive: true });
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
      case 'c': case 'C':
        toggleCrt();
        showHud(els.ch.textContent, els.tv.classList.contains('crt-off') ? '(crt off)' : '(crt on)');
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
  loadCrt();
  setupKeys();
  setupScrub();
  setupTouch();
  els.share.addEventListener('click',   e => { e.stopPropagation(); onShareClick(); });
  els.crt.addEventListener('click',     e => { e.stopPropagation(); toggleCrt(); });
  els.prevBtn.addEventListener('click', e => { e.stopPropagation(); prev(); });
  els.nextBtn.addEventListener('click', e => { e.stopPropagation(); next(); });
  console.log('[smashtv] booting');
  els.video.addEventListener('ended', next);
  els.video.addEventListener('error', () => { console.warn('video error, skipping'); next(); });

  const { v: wantId, t: wantT } = parseUrlParams();
  let started = false;

  // Called once per playlist page. The first call kicks off playback; later
  // calls just extend the playlist in the background.
  const onPage = (newItems, isFinal) => {
    if (!started) {
      state.items = newItems.slice();
      setOrder();

      // Honor ?v=<identifier> against whatever's loaded so far. If the deep-link
      // target isn't in this page, we still inject it as a placeholder so
      // resolveItem() can fetch its metadata directly.
      if (wantId) {
        const idx = state.items.findIndex(it => it.identifier === wantId);
        if (idx >= 0) {
          const orderIdx = state.order.indexOf(idx);
          if (orderIdx > 0) {
            state.order.splice(orderIdx, 1);
            state.order.unshift(idx);
          }
        } else {
          state.items.unshift({ identifier: wantId, title: wantId });
          state.order = state.order.map(i => i + 1);
          state.order.unshift(0);
        }
      }
      started = true;
      console.log('[smashtv] first page ready', state.items.length, 'items — starting playback');
      playAt(0, { startAt: wantT });
    } else {
      appendItems(newItems);
      console.log('[smashtv] +', newItems.length, 'items — total', state.items.length, isFinal ? '(final)' : '');
    }
  };

  try {
    await loadPlaylistStreaming(onPage);
  } catch (e) {
    console.error('[smashtv] playlist load failed', e);
    if (!started) showHud('ERR', 'failed to load playlist: ' + e.message);
    // If we already started, the user keeps whatever pages did arrive.
  }
  if (!started) { showHud('---', 'no videos found'); }
})();
