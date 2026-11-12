/* Music Vault — a static page that reads and writes a private GitHub repo.
 *
 * Built from Movie Vault and works the same way. There is no server and the
 * page holds no data. On sign-in you supply a fine-grained token, kept in this
 * browser only, and every read and write is a direct call to the GitHub API.
 * Each edit becomes a real commit.
 *
 * Album details come from MusicBrainz and covers from the Cover Art Archive,
 * both called straight from the browser. Neither needs a key.
 *
 * The one rule that matters: edits are SURGICAL. We never parse the YAML and
 * re-serialise it. We replace exactly the lines we mean to and leave every
 * other byte alone (see frontmatter.js).
 */

'use strict';

const API = 'https://api.github.com';
const MB = 'https://musicbrainz.org/ws/2';
const CAA = 'https://coverartarchive.org';
const ART_CACHE = 'music-vault-artwork-v1';
const LS = { owner: 'muv_owner', repo: 'muv_repo', token: 'muv_token' };
const LS_VIEW = 'muv_view';                 // a preference, not a credential — survives sign-out
const FORMATS = ['ALAC', 'FLAC', 'WAV', 'AIFF', 'MP3', 'AAC'];

const state = {
  owner: '', repo: '', token: '',
  albums: [],
  view: 'library',                          // 'library' | 'shopping'
  filters: { q: '', artist: '', format: '', label: '', decade: '', rating: '', genre: '' },
  filtersOpen: false,
};

const el = (id) => document.getElementById(id);

/* ── small utilities ──────────────────────────────────────────────────── */

const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** UTF-8 safe base64. btoa() alone corrupts accented titles. */
function toB64(str) {
  const bytes = new TextEncoder().encode(str);
  return bytesToB64(bytes);
}
function bytesToB64(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}
function fromB64(b64) {
  const bin = atob(b64.replace(/\s/g, ''));
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

let toastTimer;
function toast(msg, kind = '') {
  const t = el('toast');
  t.textContent = msg;
  t.className = 'toast ' + kind;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, kind === 'bad' ? 6000 : 2200);
}

function status(text, kind = '') {
  const s = el('sync');
  if (!s) return;
  s.textContent = text;
  s.className = 'sync ' + kind;
  if (kind === 'saved') setTimeout(() => { if (s.textContent === text) s.textContent = ''; }, 2500);
}

const albumLabel = (a) => `${a.artist ? a.artist + ' — ' : ''}${a.title || a.slug}`;

/* ── GitHub API ───────────────────────────────────────────────────────── */

function ghHeaders(extra = {}) {
  return {
    Authorization: `Bearer ${state.token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    ...extra,
  };
}

const contentsURL = (path) =>
  `${API}/repos/${state.owner}/${state.repo}/contents/${path.split('/').map(encodeURIComponent).join('/')}`;

async function ghError(res) {
  let detail = '';
  try { detail = (await res.json()).message || ''; } catch { /* no body */ }
  if (res.status === 401) return 'Token rejected — it may have been revoked.';
  if (res.status === 403) return 'Token lacks permission for this repo.';
  if (res.status === 404) return 'Not found — check the user and repo names.';
  if (res.status === 409) return 'File changed on GitHub. Try again.';
  return `GitHub error ${res.status}${detail ? ': ' + detail : ''}`;
}

/** Text of a file, plus the version id needed to write it back. */
async function readFile(path) {
  const res = await fetch(contentsURL(path), { headers: ghHeaders(), cache: 'no-store' });
  if (!res.ok) throw new Error(await ghError(res));
  const json = await res.json();
  return { text: fromB64(json.content), sha: json.sha };
}

/** Raw bytes — used for artwork, which we never want base64-inflated. */
async function readBlob(path) {
  const res = await fetch(contentsURL(path), {
    headers: ghHeaders({ Accept: 'application/vnd.github.raw' }),
  });
  if (!res.ok) throw new Error(await ghError(res));
  return res.blob();
}

async function currentSha(path) {
  const head = await fetch(contentsURL(path), { headers: ghHeaders(), cache: 'no-store' });
  if (head.ok) return (await head.json()).sha;
  if (head.status === 404) return undefined;
  throw new Error(await ghError(head));
}

/**
 * Commit a file. The version id is fetched immediately beforehand rather than
 * reused from an earlier read, so a change pushed from a Mac in the meantime
 * cannot be silently overwritten.
 */
async function writeFile(path, text, message, { isNew = false, base64 = null } = {}) {
  const sha = isNew ? undefined : await currentSha(path);
  const res = await fetch(contentsURL(path), {
    method: 'PUT',
    headers: ghHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ message, content: base64 ?? toB64(text), ...(sha ? { sha } : {}) }),
  });
  if (!res.ok) throw new Error(await ghError(res));
  return res.json();
}

async function deleteFile(path, message) {
  const sha = await currentSha(path);
  if (!sha) return;
  const res = await fetch(contentsURL(path), {
    method: 'DELETE',
    headers: ghHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ message, sha }),
  });
  if (!res.ok) throw new Error(await ghError(res));
}

/** Wraps a save so a failure is always visible and never silent. */
async function save(label, fn) {
  status('Saving…', 'saving');
  try {
    await fn();
    status('Saved', 'saved');
    return true;
  } catch (err) {
    status('Not saved', 'failed');
    toast(`${label} failed — ${err.message}`, 'bad');
    return false;
  }
}

/* ── Surgical frontmatter editing (see frontmatter.js) ────────────── */

const { splitFile, joinFile, yamlValue, setScalar, setList, setBlock, getList, setBody } = FM;

/** Read one single-line scalar back out of raw frontmatter. */
function getScalar(fm, key) {
  const m = fm.match(new RegExp(`^${key}:\\s*(.*)$`, 'm'));
  if (!m) return null;
  const v = m[1].trim();
  if (v === '' || v === 'null' || v === '~') return null;
  return v.replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1');
}

/** Tracks are one-line flow maps — valid JSON, so JSON.parse reads them. */
function getTracks(fm) {
  const lines = fm.split('\n');
  const start = lines.findIndex((l) => /^tracks:\s*$/.test(l));
  if (start === -1) return [];
  const out = [];
  for (let i = start + 1; i < lines.length && /^-\s/.test(lines[i]); i++) {
    try { out.push(JSON.parse(lines[i].replace(/^-\s+/, ''))); } catch { /* skip a hand-mangled line */ }
  }
  return out;
}

/** One-line JSON map per track, spaced like Python's json.dumps so files
 *  written by the app and by the importer look the same. */
const trackLine = (t) => '- {' + Object.entries({
  disc: t.disc || 1, number: t.number, title: t.title, length: t.length || null,
}).map(([k, v]) => `${JSON.stringify(k)}: ${JSON.stringify(v)}`).join(', ') + '}';

const renderTracks = (tracks) => (tracks.length ? ['tracks:', ...tracks.map(trackLine)] : ['tracks: []']);

/** Read, change, write one album file — the shape of every edit below. */
async function editAlbum(album, change, message) {
  const path = `albums/${album.slug}.md`;
  const fresh = (await readFile(path)).text;
  const parts = splitFile(fresh);
  const updated = joinFile(change(parts.fm), parts.body);
  if (updated === fresh) return fresh;
  await writeFile(path, updated, message);
  noteSaved(album, updated);
  return updated;
}

/* ── Artwork ──────────────────────────────────────────────────────────── */

/**
 * Private repos cannot be used as an <img src>, so covers are fetched by JS
 * and cached. First sight of an album is a network call; every sight after
 * that is instant and offline.
 */
async function artBlob(filename) {
  const key = `/artwork/${filename}`;
  try {
    const cache = await caches.open(ART_CACHE);
    const hit = await cache.match(key);
    if (hit) return hit.blob();
    const blob = await readBlob(`artwork/${filename}`);
    await cache.put(key, new Response(blob.slice()));
    return blob;
  } catch {
    return readBlob(`artwork/${filename}`);  // caches unavailable (insecure context)
  }
}

/** One object URL per cover, kept for the life of the page (never revoked). */
const artURLs = new Map();

async function artURL(filename) {
  const existing = artURLs.get(filename);
  if (existing) return existing;
  const url = URL.createObjectURL(await artBlob(filename));
  artURLs.set(filename, url);
  return url;
}

/** A replaced cover must not keep showing the old cached one. */
async function forgetArt(filename) {
  artURLs.delete(filename);
  try { (await caches.open(ART_CACHE)).delete(`/artwork/${filename}`); } catch { /* fine */ }
}

const artObserver = new IntersectionObserver(async (entries) => {
  for (const entry of entries) {
    if (!entry.isIntersecting) continue;
    const holder = entry.target;
    artObserver.unobserve(holder);
    const file = holder.dataset.art;
    if (!file || holder.querySelector('img')) continue;
    try {
      const img = new Image();
      img.alt = '';
      img.src = await artURL(file);
      holder.querySelector('.fallback')?.remove();
      holder.prepend(img);
    } catch { /* leave the title fallback showing */ }
  }
}, { rootMargin: '400px' });

/** Any image blob → 500px-wide JPEG as base64, matching the collection. */
async function shrinkToJpegB64(blob) {
  const bitmap = await createImageBitmap(blob);
  const w = Math.min(500, bitmap.width);
  const h = Math.round(bitmap.height * (w / bitmap.width));
  const canvas = Object.assign(document.createElement('canvas'), { width: w, height: h });
  canvas.getContext('2d').drawImage(bitmap, 0, 0, w, h);
  const out = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.85));
  return { base64: bytesToB64(new Uint8Array(await out.arrayBuffer())), blob: out };
}

/* ── MusicBrainz + Cover Art Archive ──────────────────────────────────── */

// MusicBrainz asks for no more than one request a second, and answers 503
// when it is overloaded or thinks we are going too fast. That is routine on
// their side, so wait and retry a few times before giving up.
let mbLast = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function mb(path) {
  const sep = path.includes('?') ? '&' : '?';
  const url = `${MB}/${path}${sep}fmt=json`;
  for (let attempt = 0; attempt < 5; attempt++) {
    const wait = Math.max(0, mbLast + 1200 - Date.now());
    if (wait) await sleep(wait);
    mbLast = Date.now();
    let res;
    try { res = await fetch(url, { headers: { Accept: 'application/json' } }); }
    catch { res = null; }                        // network blip — retry
    if (res && res.ok) return res.json();
    if (res && res.status !== 503 && res.status !== 429) throw new Error(`MusicBrainz error ${res.status}`);
    status(`MusicBrainz busy — retrying (${attempt + 1}/4)…`, 'saving');
    await sleep(2000 * (attempt + 1));           // 2s, 4s, 6s, 8s
  }
  status('');
  throw new Error('MusicBrainz is still busy — try again in a minute.');
}

const luceneQuote = (s) => `"${s.replace(/["\\]/g, ' ').trim()}"`;

async function searchReleaseGroups(artist, title) {
  const parts = [];
  if (title) parts.push(`releasegroup:${luceneQuote(title)}`);
  if (artist) parts.push(`artist:${luceneQuote(artist)}`);
  if (!parts.length) return [];
  const data = await mb(`release-group?query=${encodeURIComponent(parts.join(' AND '))}&limit=15`);
  return (data['release-groups'] || []).map((g) => ({
    id: g.id,
    title: g.title,
    artist: (g['artist-credit'] || []).map((c) => (c.name || c.artist?.name || '') + (c.joinphrase || '')).join('').trim(),
    year: parseInt((g['first-release-date'] || '').slice(0, 4), 10) || null,
    type: [g['primary-type'], ...(g['secondary-types'] || [])].filter(Boolean).join(' · '),
  }));
}

/**
 * A release group is the album; its releases are the pressings. Use the
 * earliest official one for the tracklist and label — the original release.
 */
async function bestRelease(groupId) {
  const data = await mb(`release?release-group=${groupId}&inc=media&limit=100`);
  const rels = data.releases || [];
  if (!rels.length) return null;
  const score = (r) => [
    r.status === 'Official' ? 0 : 1,
    r.date ? r.date.padEnd(10, '9') : '9999',
  ];
  rels.sort((a, b) => {
    const A = score(a), B = score(b);
    return A[0] - B[0] || A[1].localeCompare(B[1]);
  });
  return rels[0].id;
}

const mmss = (ms) => {
  if (!ms) return null;
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

async function releaseDetails(releaseId) {
  const r = await mb(`release/${releaseId}?inc=recordings+labels+artist-credits`);
  const tracks = [];
  (r.media || []).forEach((m, i) => {
    for (const t of (m.tracks || [])) {
      tracks.push({ disc: m.position || i + 1, number: t.position, title: t.title, length: mmss(t.length) });
    }
  });
  const label = (r['label-info'] || []).map((li) => li.label?.name).find(Boolean) || null;
  return {
    releaseId, tracks, label,
    discs: (r.media || []).length || 1,
    year: parseInt((r.date || '').slice(0, 4), 10) || null,
    artist: (r['artist-credit'] || []).map((c) => (c.name || c.artist?.name || '') + (c.joinphrase || '')).join('').trim(),
  };
}

/** Front cover from the Cover Art Archive. Null if there is none, or the
 *  browser refuses to hand over the bytes. */
async function fetchCover(groupId, releaseId) {
  for (const url of [`${CAA}/release-group/${groupId}/front-500`, releaseId && `${CAA}/release/${releaseId}/front-500`]) {
    if (!url) continue;
    try {
      const res = await fetch(url, { mode: 'cors' });
      if (res.ok) return await res.blob();
    } catch { /* try the next */ }
  }
  return null;
}

/* ── Loading the catalogue ────────────────────────────────────────────── */

/**
 * index.json is rebuilt by a GitHub Action after every commit, which takes a
 * minute — and if the Action ever fails, the index goes stale. So the app never
 * trusts it alone: it also lists the albums/ folder (one request) and reads any
 * album the index doesn't know about yet, and drops any that were deleted.
 * What you see always matches the files, whatever state the Action is in.
 */
async function loadCatalogue() {
  const [{ text }, listing] = await Promise.all([readFile('index.json'), listAlbums()]);
  const data = JSON.parse(text);
  let albums = data.albums || [];
  if (listing) {
    const onDisk = new Set(listing);
    albums = albums.filter((a) => onDisk.has(a.slug));
    const known = new Set(albums.map((a) => a.slug));
    const missing = listing.filter((slug) => !known.has(slug));
    const rows = await Promise.all(missing.map((slug) => readFile(`albums/${slug}.md`)
      .then(({ text: t }) => rowFromFile(slug, t)).catch(() => null)));
    albums = albums.concat(rows.filter(Boolean));
    albums.sort((a, b) => String(a.artist || '').localeCompare(String(b.artist || '')) ||
      (a.release_year || 0) - (b.release_year || 0));
  }
  state.albums = albums;
}

/** Slugs of every album file, or null if the folder can't be listed. */
async function listAlbums() {
  try {
    const res = await fetch(contentsURL('albums'), { headers: ghHeaders(), cache: 'no-store' });
    if (!res.ok) return null;
    return (await res.json()).filter((f) => f.type === 'file' && f.name.endsWith('.md'))
      .map((f) => f.name.replace(/\.md$/, ''));
  } catch { return null; }
}

/** The same row build_index.py makes, read straight from one file. */
function rowFromFile(slug, text) {
  const { fm, body } = splitFile(text);
  const num = (v) => (v != null && v !== '' && !isNaN(Number(v)) ? Number(v) : undefined);
  const tracks = getTracks(fm);
  const secs = tracks.reduce((n, t) => {
    const [m, x] = String(t.length || '').split(':').map(Number);
    return n + (m || 0) * 60 + (x || 0);
  }, 0);
  const row = {
    slug,
    title: getScalar(fm, 'title') || undefined,
    artist: getScalar(fm, 'artist') || undefined,
    status: getScalar(fm, 'status') || 'library',
    release_year: num(getScalar(fm, 'release_year')),
    label: getScalar(fm, 'label') || undefined,
    quality: getScalar(fm, 'quality') || undefined,
    rating: num(getScalar(fm, 'rating')) ?? null,
    discs: num(getScalar(fm, 'discs')),
    track_count: tracks.length,
  };
  const formats = getList(fm, 'formats'); if (formats.length) row.formats = formats;
  const genres = getList(fm, 'genres'); if (genres.length) row.genres = genres;
  const art = getScalar(fm, 'artwork'); if (art) row.artwork = art.split('/').pop();
  if (secs) row.total_length = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
  if (body.trim()) row.has_notes = true;
  return row;
}

/* ── Filtering ────────────────────────────────────────────────────────── */

const decadeOf = (a) => (Number.isInteger(a.release_year) ? Math.floor(a.release_year / 10) * 10 : null);
const ratingStr = (r) => (r === null || r === undefined ? '' : String(r));
const inView = (a) => (a.status || 'library') === state.view;

function visibleAlbums() {
  const f = state.filters;
  const q = f.q.trim().toLowerCase();
  return state.albums.filter((a) => {
    if (!inView(a)) return false;
    if (q) {
      const hay = [a.title, a.artist, a.label].join(' ').toLowerCase();
      if (!hay.includes(q)) return false;
    }
    if (f.artist && a.artist !== f.artist) return false;
    if (f.label && a.label !== f.label) return false;
    if (f.genre && !(a.genres || []).includes(f.genre)) return false;
    if (f.format && !(a.formats || []).includes(f.format)) return false;
    if (f.decade && String(decadeOf(a)) !== f.decade) return false;
    if (f.rating === 'unrated' && a.rating != null) return false;
    if (f.rating && f.rating !== 'unrated' && ratingStr(a.rating) !== f.rating) return false;
    return true;
  });
}

function uniqueValues(key, all = false) {
  const set = new Set();
  for (const a of state.albums) {
    if (!all && !inView(a)) continue;
    const v = a[key];
    if (Array.isArray(v)) v.forEach((x) => set.add(x));
    else if (v) set.add(v);
  }
  return [...set].sort((x, y) => String(x).localeCompare(String(y)));
}

/** Every filter change goes through here, so the three views never drift apart. */
function setFilter(key, value) {
  state.filters[key] = state.filters[key] === value ? '' : value;
  renderAll();
}

function setView(view) {
  state.view = view;
  try { localStorage.setItem(LS_VIEW, view); } catch { /* private mode */ }
  renderAll();
  window.scrollTo(0, 0);
}

/* ── Collection rendering ─────────────────────────────────────────────── */

function renderAll() {
  renderTabs();
  renderFilters();
  renderActive();
  renderGrid();
}

function renderTabs() {
  const n = (v) => state.albums.filter((a) => (a.status || 'library') === v).length;
  el('n-library').textContent = n('library');
  el('n-shopping').textContent = n('shopping');
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('on', t.dataset.view === state.view));
}

function renderFilters() {
  const box = el('filters');
  box.hidden = !state.filtersOpen;
  if (!state.filtersOpen) return;

  const decades = [...new Set(state.albums.filter(inView).map(decadeOf).filter((d) => d !== null))]
    .sort((a, b) => b - a);
  const ratings = ['5', '4.5', '4', '3.5', '3', '2.5', '2', '1.5', '1', '0.5', 'unrated'];
  const groups = [
    ['Format', 'format', state.view === 'library' ? uniqueValues('formats') : []],
    ['Genre', 'genre', uniqueValues('genres')],
    ['Decade', 'decade', decades.map(String)],
    ['Rating', 'rating', ratings],
    ['Label', 'label', uniqueValues('label')],
    ['Artist', 'artist', uniqueValues('artist')],
  ].filter(([, , values]) => values.length);

  box.innerHTML = groups.map(([label, key, values]) => `
    <h4>${label}</h4>
    <div class="chips">
      ${values.map((v) => {
        const on = state.filters[key] === v;
        const text = key === 'decade' ? `${v}s` : (v === 'unrated' ? 'Unrated' : v);
        return `<button class="chip ${on ? 'on' : ''}" data-key="${key}" data-val="${escapeHtml(v)}">${escapeHtml(text)}</button>`;
      }).join('')}
    </div>`).join('');

  box.querySelectorAll('.chip').forEach((chip) => {
    chip.onclick = () => setFilter(chip.dataset.key, chip.dataset.val);
  });
}

const FILTER_LABELS = { artist: 'Artist', format: 'Format', label: 'Label', decade: 'Decade',
                        rating: 'Rating', genre: 'Genre' };

function filterLabel(key, value) {
  if (key === 'decade') return `${value}s`;
  if (key === 'rating') return value === 'unrated' ? 'Unrated' : `${value} stars`;
  return value;
}

function renderActive() {
  const box = el('active');
  const on = Object.entries(state.filters).filter(([k, v]) => k !== 'q' && v);
  box.hidden = on.length === 0;
  box.innerHTML = on.map(([k, v]) => `
    <button class="pill" data-key="${k}">
      <span class="pill-key">${FILTER_LABELS[k]}</span>${escapeHtml(filterLabel(k, v))}
      <span class="pill-x">✕</span>
    </button>`).join('');
  box.querySelectorAll('.pill').forEach((pill) => {
    pill.onclick = () => setFilter(pill.dataset.key, state.filters[pill.dataset.key]);
  });
}

function renderGrid() {
  const albums = visibleAlbums();
  const total = state.albums.filter(inView).length;
  const grid = el('grid');
  el('count').textContent =
    `${albums.length} album${albums.length === 1 ? '' : 's'}${albums.length !== total ? ` of ${total}` : ''}`;
  el('empty').hidden = albums.length > 0;
  el('empty').textContent = total === 0 && state.view === 'shopping'
    ? 'Shopping list is empty. Tap ＋ to add an album.' : 'Nothing matches.';

  grid.innerHTML = albums.map((a) => `
    <article class="card" data-slug="${escapeHtml(a.slug)}">
      <div class="poster" ${a.artwork ? `data-art="${escapeHtml(a.artwork)}"` : ''}>
        <div class="fallback">${escapeHtml(a.title || a.slug)}</div>
        ${a.rating != null ? `<span class="badge">${ratingStr(a.rating)}</span>` : ''}
      </div>
      <h3>${escapeHtml(a.title || a.slug)}</h3>
      <div class="artist">${escapeHtml(a.artist || '')}</div>
    </article>`).join('');

  grid.querySelectorAll('.card').forEach((card) => {
    card.onclick = () => openDetail(card.dataset.slug);
  });
  grid.querySelectorAll('.poster[data-art]').forEach((p) => artObserver.observe(p));
}

/* ── Stars ────────────────────────────────────────────────────────────── */

const STAR_PATH = 'M12 2.5l2.95 5.98 6.6.96-4.78 4.66 1.13 6.57L12 17.57 6.1 20.67l1.13-6.57L2.45 9.44l6.6-.96z';

function starSvg(kind) {
  const id = 'g' + Math.random().toString(36).slice(2, 8);
  if (kind === 'half') {
    return `<svg viewBox="0 0 24 24" aria-hidden="true">
      <defs><linearGradient id="${id}"><stop offset="50%" stop-color="currentColor" class="fill"/>
      <stop offset="50%" stop-color="#3a4049"/></linearGradient></defs>
      <path d="${STAR_PATH}" fill="url(#${id})" style="color:var(--accent)"/></svg>`;
  }
  const colour = kind === 'full' ? 'var(--accent)' : '#3a4049';
  return `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${STAR_PATH}" fill="${colour}"/></svg>`;
}

function renderStars(container, value, onPick) {
  const v = value ?? 0;
  container.innerHTML = `<div class="stars">
    ${[1, 2, 3, 4, 5].map((i) => {
      const kind = v >= i ? 'full' : (v >= i - 0.5 ? 'half' : 'none');
      return `<span class="star">${starSvg(kind)}
        <span class="half l" data-v="${i - 0.5}"></span>
        <span class="half r" data-v="${i}"></span></span>`;
    }).join('')}
    ${value != null ? '<button class="rating-clear">Clear</button>' : ''}
  </div>`;
  container.querySelectorAll('.half').forEach((h) => {
    h.onclick = () => onPick(parseFloat(h.dataset.v));
  });
  container.querySelector('.rating-clear')?.addEventListener('click', () => onPick(null));
}

/* ── Detail sheet ─────────────────────────────────────────────────────── */

let current = null;   // { album, text }

/** Record a write against the open sheet, unless it has moved on meanwhile. */
function noteSaved(album, updated) {
  if (current && current.album === album) current.text = updated;
}

let openSeq = 0;      // bumps on every open, so a slow load can't land on a later sheet

async function openDetail(slug, { random = false } = {}) {
  const album = state.albums.find((a) => a.slug === slug);
  if (!album) return;
  const seq = ++openSeq;
  const sheet = el('detail');
  sheet.hidden = false;
  sheet.scrollTop = 0;
  sheet.innerHTML = `<div class="sheet-head"><button class="icon" id="d-close">✕</button>
    <h2>${escapeHtml(album.title || slug)}</h2>
    ${random ? '<button class="icon" id="d-again" aria-label="Another random album">🎲</button>' : ''}</div>
    <div class="sheet-body"><p class="muted">Loading…</p></div>`;
  el('d-close').onclick = closeDetail;
  if (random) el('d-again').onclick = pickRandom;

  try {
    const { text } = await readFile(`albums/${slug}.md`);
    if (seq !== openSeq) return;
    current = { album, text };
    renderDetail();
  } catch (err) {
    if (seq !== openSeq) return;
    sheet.querySelector('.sheet-body').innerHTML =
      `<p class="error">Could not open this album — ${escapeHtml(err.message)}</p>`;
  }
}

function pickRandom() {
  const pool = visibleAlbums();
  if (pool.length === 0) { toast('Nothing to pick from.'); return; }
  const others = pool.filter((a) => a.slug !== current?.album.slug);
  const choices = others.length ? others : pool;
  const pick = choices[Math.floor(Math.random() * choices.length)];
  current = null;
  openDetail(pick.slug, { random: true });
}

function closeDetail() {
  el('detail').hidden = true;
  current = null;
  renderAll();
}

/** Leave the album and show everything else by this artist or on this label. */
function filterBy(key, value) {
  for (const k of Object.keys(state.filters)) state.filters[k] = '';
  state.filters[key] = value;
  el('search').value = '';
  state.filtersOpen = false;
  closeDetail();
  window.scrollTo(0, 0);
}

function trackListHtml(tracks, discs) {
  if (!tracks.length) return '<p class="hint">No tracklist yet. Use “Fill from MusicBrainz” below.</p>';
  const multi = discs > 1 || new Set(tracks.map((t) => t.disc || 1)).size > 1;
  let html = '', lastDisc = null;
  for (const t of tracks) {
    const d = t.disc || 1;
    if (multi && d !== lastDisc) {
      if (lastDisc !== null) html += '</ul>';
      html += `<div class="disc-head">Disc ${d}</div><ul class="tracks">`;
      lastDisc = d;
    } else if (lastDisc === null) { html += '<ul class="tracks">'; lastDisc = d; }
    html += `<li><span class="no">${escapeHtml(t.number ?? '')}</span>
      <span class="t">${escapeHtml(t.title || '')}</span>
      <span class="len">${escapeHtml(t.length || '')}</span></li>`;
  }
  return html + '</ul>';
}

function renderDetail() {
  if (!current) return;
  const { album, text } = current;
  const { fm, body } = splitFile(text);
  const formats = getList(fm, 'formats');
  const genres = getList(fm, 'genres');
  const tracks = getTracks(fm);
  const discs = parseInt(getScalar(fm, 'discs'), 10) || 1;
  const quality = getScalar(fm, 'quality');
  const isShopping = (album.status || 'library') === 'shopping';
  // 139:14 reads badly; anything an hour or over is shown as 2h 19m.
  const total = (() => {
    const [m, sec] = String(album.total_length || '').split(':').map(Number);
    if (!m && !sec) return '';
    return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : album.total_length;
  })();

  const link = (key, value) => value
    ? `<button class="credit" data-key="${key}" data-val="${escapeHtml(value)}">${escapeHtml(value)}</button>` : '';
  const meta = [
    ['Artist', link('artist', album.artist)],
    ['Year', escapeHtml(album.release_year || '')],
    ['Label', link('label', album.label)],
    ['Length', escapeHtml([total, album.track_count ? `${album.track_count} tracks` : ''].filter(Boolean).join(' · '))],
    ['Quality', escapeHtml(quality || '')],
  ].filter(([, v]) => v);

  el('detail').querySelector('.sheet-body').innerHTML = `
    <div class="hero">
      <div class="poster" ${album.artwork ? `data-art="${escapeHtml(album.artwork)}"` : ''}>
        <div class="fallback">${escapeHtml(album.title || album.slug)}</div>
      </div>
      <div class="hero-meta">
        <h1>${escapeHtml(album.title || album.slug)}</h1>
        <dl>${meta.map(([label, v]) => `<dt>${label}</dt><dd>${v}</dd>`).join('')}</dl>
        <span class="status-tag ${isShopping ? 'shopping' : ''}">${isShopping ? 'Shopping list' : 'Library'}</span>
      </div>
    </div>

    <div class="field"><h4>Rating</h4><div id="d-stars"></div></div>

    ${isShopping ? `
      <div class="field" id="d-move">
        <button class="primary" id="d-move-btn">Got it — move to library</button>
      </div>` : `
      <div class="field"><h4>Format</h4>
        <div class="chips" id="d-formats">
          ${FORMATS.map((f) => `<button class="chip ${formats.includes(f) ? 'on' : ''}" data-f="${f}">${f}</button>`).join('')}
        </div>
      </div>`}

    <div class="field"><h4>Genre</h4>
      <div class="typeahead">
        <input id="d-genre" type="text" autocapitalize="off" autocorrect="off" spellcheck="false"
               value="${escapeHtml(genres.join(', '))}" placeholder="Not set">
        <div class="typeahead-list" id="d-genre-list" hidden></div>
      </div>
      <p class="hint">Separate several with commas. Press return to save.</p>
    </div>

    <div class="field"><h4>Tracklist</h4>${trackListHtml(tracks, discs)}</div>

    <div class="field"><h4>Notes</h4>
      <textarea id="d-body" placeholder="Notes…">${escapeHtml(body.trim())}</textarea>
      <div class="row-actions"><button id="d-save-body" class="primary">Save notes</button></div>
    </div>

    <div class="field"><h4>Details</h4>
      <button class="secondary" id="d-mb">Fill from MusicBrainz</button>
      <p class="hint">Fills in anything missing — label, tracklist, cover — and never overwrites what is already here.</p>
      <div id="d-mb-box"></div>
    </div>

    ${isShopping ? `<div class="field"><button class="danger" id="d-remove">Remove from shopping list</button></div>` : ''}`;

  el('detail').querySelectorAll('.poster[data-art]').forEach((p) => artObserver.observe(p));
  el('detail').querySelectorAll('.credit').forEach((btn) => {
    btn.onclick = () => filterBy(btn.dataset.key, btn.dataset.val);
  });

  bindStars(el('d-stars'), album);

  if (isShopping) {
    el('d-move-btn').onclick = () => showMoveToLibrary(album);
    el('d-remove').onclick = () => removeFromShopping(album);
  } else {
    el('d-formats').querySelectorAll('.chip').forEach((chip) => {
      chip.onclick = () => toggleFormat(album, chip.dataset.f, chip);
    });
  }

  bindGenre(album, genres);

  el('d-save-body').onclick = async () => {
    const value = el('d-body').value;
    await save('Notes', async () => {
      const path = `albums/${album.slug}.md`;
      const fresh = (await readFile(path)).text;
      const updated = setBody(fresh, value.trim() ? value.trim() + '\n' : '');
      await writeFile(path, updated, `Update notes for ${albumLabel(album)}`);
      noteSaved(album, updated);
      album.has_notes = !!value.trim();
    });
  };

  el('d-mb').onclick = () => openMusicBrainzMatch(album);
}

function bindStars(box, album) {
  renderStars(box, album.rating ?? null, async (value) => {
    const before = album.rating ?? null;
    album.rating = value;                       // optimistic: redraw immediately
    bindStars(box, album);
    const ok = await save('Rating', () => editAlbum(album,
      (fm) => setScalar(fm, 'rating', value === null ? 'null' : value),
      value === null ? `Clear rating for ${albumLabel(album)}` : `Rate ${albumLabel(album)} ${value}/5`));
    if (!ok) { album.rating = before; bindStars(box, album); }
  });
}

/** Library formats: tap to add or remove. An album can be held in several. */
async function toggleFormat(album, format, chip) {
  chip.classList.toggle('on');
  let next;
  const ok = await save('Format', () => editAlbum(album, (fm) => {
    const have = getList(fm, 'formats');
    next = have.includes(format) ? have.filter((f) => f !== format)
                                 : FORMATS.filter((f) => have.includes(f) || f === format);
    return setList(fm, 'formats', next);
  }, `Set format of ${albumLabel(album)}`));
  if (ok) album.formats = next;
  else chip.classList.toggle('on');
}

/** Shopping → library. The format is asked for here, so both land in one commit. */
function showMoveToLibrary(album) {
  const box = el('d-move');
  box.innerHTML = `<div class="move-box">
    <h4 style="margin:0 0 8px">Which format did you get?</h4>
    <div class="chips" id="m-formats">
      ${FORMATS.map((f) => `<button class="chip" data-f="${f}">${f}</button>`).join('')}
    </div>
    <div class="row-actions">
      <button id="m-cancel">Cancel</button>
      <button id="m-go" class="primary" style="flex:1">Move to library</button>
    </div></div>`;
  box.querySelectorAll('#m-formats .chip').forEach((c) => { c.onclick = () => c.classList.toggle('on'); });
  el('m-cancel').onclick = renderDetail;
  el('m-go').onclick = async () => {
    const formats = [...box.querySelectorAll('#m-formats .chip.on')].map((c) => c.dataset.f);
    if (!formats.length) return toast('Pick at least one format', 'bad');
    const ok = await save('Move', () => editAlbum(album,
      (fm) => setList(setScalar(fm, 'status', 'library'), 'formats', formats),
      `Move ${albumLabel(album)} to library (${formats.join(', ')})`));
    if (ok) {
      album.status = 'library';
      album.formats = formats;
      toast('Moved to library', 'good');
      renderDetail();
      renderTabs();
    }
  };
}

async function removeFromShopping(album) {
  if (!confirm(`Remove ${albumLabel(album)} from the shopping list?`)) return;
  const ok = await save('Remove', async () => {
    await deleteFile(`albums/${album.slug}.md`, `Remove ${albumLabel(album)} from shopping list`);
    if (album.artwork) {
      await deleteFile(`artwork/${album.artwork}`, `Remove cover for ${albumLabel(album)}`).catch(() => {});
    }
  });
  if (ok) {
    state.albums = state.albums.filter((a) => a !== album);
    toast('Removed', 'good');
    closeDetail();
  }
}

/* ── Genre (not populated yet; free text with suggestions) ─────────────── */

function bindGenre(album, currentGenres) {
  const input = el('d-genre');
  const list = el('d-genre-list');
  const close = () => { list.hidden = true; };

  const commit = async () => {
    close();
    const next = [...new Set(input.value.split(',').map((s) => s.trim()).filter(Boolean))];
    if (next.join('|') === currentGenres.join('|')) return;
    const ok = await save('Genre', () => editAlbum(album, (fm) => setList(fm, 'genres', next),
      next.length ? `Set genre of ${albumLabel(album)} to ${next.join(', ')}` : `Clear genre of ${albumLabel(album)}`));
    if (ok) { album.genres = next; currentGenres = next; toast('Genre saved', 'good'); }
  };

  input.oninput = () => {
    const parts = input.value.split(',');
    const q = parts[parts.length - 1].trim().toLowerCase();
    const known = uniqueValues('genres', true).filter((g) => g.toLowerCase().includes(q) && !parts.slice(0, -1).map((p) => p.trim()).includes(g));
    if (!q || !known.length) return close();
    list.innerHTML = known.map((g) => `<div data-g="${escapeHtml(g)}">${escapeHtml(g)}</div>`).join('');
    list.hidden = false;
    list.querySelectorAll('[data-g]').forEach((row) => {
      row.onmousedown = (e) => e.preventDefault();
      row.onclick = () => {
        parts[parts.length - 1] = ' ' + row.dataset.g;
        input.value = parts.join(',').replace(/^\s+/, '');
        commit();
      };
    });
  };
  input.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); input.blur(); } };
  input.onblur = () => setTimeout(commit, 150);
}

/* ── Fill an existing album from MusicBrainz ──────────────────────────── */

function openMusicBrainzMatch(album) {
  const box = el('d-mb-box');
  box.innerHTML = '<p class="hint">Searching MusicBrainz…</p>';
  searchReleaseGroups(album.artist, album.title).then((groups) => {
    if (!groups.length) { box.innerHTML = '<p class="hint">No match found.</p>'; return; }
    box.innerHTML = `<p class="hint">Pick the right one:</p>${resultsHtml(groups)}`;
    bindResults(box, groups, async (g) => {
      box.innerHTML = '<p class="hint">Fetching details…</p>';
      try { await fillAlbum(album, g); box.innerHTML = ''; }
      catch (err) { box.innerHTML = `<p class="error">${escapeHtml(err.message)}</p>`; }
    });
  }).catch((err) => { box.innerHTML = `<p class="error">${escapeHtml(err.message)}</p>`; });
}

async function fillAlbum(album, group) {
  // A release id read from the files' own tags is the exact pressing owned, so
  // it beats guessing the original release.
  const tagged = current && current.album === album ? getScalar(splitFile(current.text).fm, 'musicbrainz_release') : null;
  let releaseId = tagged, det = null;
  if (releaseId) { try { det = await releaseDetails(releaseId); } catch { releaseId = null; } }
  if (!det) {
    releaseId = await bestRelease(group.id);
    det = releaseId ? await releaseDetails(releaseId) : { tracks: [], label: null, discs: 1, year: null };
  }
  const needCover = !album.artwork;
  const cover = needCover ? await fetchCover(group.id, releaseId) : null;
  const filled = [];

  const ok = await save('MusicBrainz', async () => {
    let coverName = null;
    if (cover) {
      const { base64 } = await shrinkToJpegB64(cover);
      coverName = `${album.slug}.jpg`;
      await writeFile(`artwork/${coverName}`, null, `Cover for ${albumLabel(album)}`, { base64 });
      filled.push('cover');
    }
    await editAlbum(album, (fm) => {
      let out = fm;
      if (!getScalar(out, 'musicbrainz_id')) out = setScalar(out, 'musicbrainz_id', group.id);
      if (!getScalar(out, 'musicbrainz_release') && releaseId) out = setScalar(out, 'musicbrainz_release', releaseId);
      if (!getScalar(out, 'label') && det.label) { out = setScalar(out, 'label', yamlValue(det.label)); filled.push('label'); }
      if (!getScalar(out, 'release_year') && (group.year || det.year)) {
        out = setScalar(out, 'release_year', group.year || det.year); filled.push('year');
      }
      if (!getTracks(out).length && det.tracks.length) {
        out = setBlock(out, 'tracks', renderTracks(det.tracks));
        out = setScalar(out, 'discs', det.discs);
        filled.push('tracklist');
      }
      if (coverName) out = setScalar(out, 'artwork', `artwork/${coverName}`);
      return out;
    }, `Fill ${albumLabel(album)} from MusicBrainz`);
    if (!album.label && det.label) album.label = det.label;
    if (!album.release_year && (group.year || det.year)) album.release_year = group.year || det.year;
    if (!album.track_count && det.tracks.length) album.track_count = det.tracks.length;
    if (coverName) { await forgetArt(coverName); album.artwork = coverName; }
  });
  if (ok) {
    toast(filled.length ? `Filled: ${filled.join(', ')}` : 'Nothing was missing', 'good');
    renderDetail();
  }
  if (needCover && !cover) toast('No cover on the Cover Art Archive — add one from Typora or the Mac.', 'bad');
}

/* ── Search results (shared by add and fill) ──────────────────────────── */

function resultsHtml(groups) {
  return `<div class="results">${groups.map((g, i) => `
    <button class="result" data-i="${i}">
      <img loading="lazy" alt="" src="${CAA}/release-group/${g.id}/front-250"
           onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'noart'}))">
      <div class="r-meta"><div>${escapeHtml(g.title)}</div>
        <div class="muted">${escapeHtml([g.artist, g.year, g.type].filter(Boolean).join(' · '))}</div></div>
    </button>`).join('')}</div>`;
}

function bindResults(box, groups, onPick) {
  box.querySelectorAll('.result').forEach((btn) => {
    btn.onclick = () => onPick(groups[Number(btn.dataset.i)]);
  });
}

/* ── Add album ────────────────────────────────────────────────────────── */

const slugify = (s) => s.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim()
  .replace(/['’]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

let draft = null;   // { group, details, artB64, artBlob }

function openAdd() {
  draft = null;
  const sheet = el('addalbum');
  sheet.hidden = false;
  sheet.scrollTop = 0;
  sheet.innerHTML = `
    <div class="sheet-head"><button class="icon" id="a-close">✕</button><h2>Add an album</h2></div>
    <div class="sheet-body">
      <div class="searchpair">
        <div class="field" style="margin:0"><label for="a-q-artist">Artist</label><input id="a-q-artist" type="text"></div>
        <div class="field" style="margin:0"><label for="a-q-title">Album</label><input id="a-q-title" type="text"></div>
        <button id="a-search" class="primary">Search MusicBrainz</button>
        <button id="a-manual" class="secondary">Enter it by hand instead</button>
      </div>
      <div id="a-results"></div>
      <div id="a-form"></div>
    </div>`;
  el('a-close').onclick = () => { el('addalbum').hidden = true; draft = null; };
  const go = () => runAddSearch();
  el('a-search').onclick = go;
  ['a-q-artist', 'a-q-title'].forEach((id) => {
    el(id).onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); go(); } };
  });
  el('a-manual').onclick = () => { el('a-results').innerHTML = ''; draft = { manual: true }; renderAddForm(); };
}

async function runAddSearch() {
  const artist = el('a-q-artist').value.trim();
  const title = el('a-q-title').value.trim();
  if (!artist && !title) return toast('Type an artist or album', 'bad');
  const box = el('a-results');
  el('a-form').innerHTML = '';
  box.innerHTML = '<p class="hint">Searching…</p>';
  try {
    const groups = await searchReleaseGroups(artist, title);
    if (!groups.length) { box.innerHTML = '<p class="hint">No match. Try fewer words, or enter it by hand.</p>'; return; }
    box.innerHTML = resultsHtml(groups);
    bindResults(box, groups, async (g) => {
      box.innerHTML = `<p class="hint">Fetching ${escapeHtml(g.title)}…</p>`;
      try {
        const releaseId = await bestRelease(g.id);
        const details = releaseId ? await releaseDetails(releaseId) : { tracks: [], label: null, discs: 1 };
        const cover = await fetchCover(g.id, releaseId);
        draft = { group: g, details };
        if (cover) {
          const { base64, blob } = await shrinkToJpegB64(cover);
          draft.artB64 = base64; draft.artBlob = blob;
        }
        box.innerHTML = '';
        renderAddForm();
      } catch (err) {
        box.innerHTML = `<p class="error">${escapeHtml(err.message)}</p>`;
      }
    });
  } catch (err) {
    box.innerHTML = `<p class="error">${escapeHtml(err.message)}</p>`;
  }
}

function renderAddForm() {
  const g = draft.group || {};
  const d = draft.details || { tracks: [] };
  const box = el('a-form');
  const startView = state.view;
  box.innerHTML = `<div class="form-grid" style="margin-top:14px">
    <div class="field"><label for="a-title">Album</label><input id="a-title" type="text" value="${escapeHtml(g.title || el('a-q-title').value)}"></div>
    <div class="field"><label for="a-artist">Artist</label><input id="a-artist" type="text" value="${escapeHtml(d.artist || g.artist || el('a-q-artist').value)}"></div>
    <div class="field"><label for="a-year">Year</label><input id="a-year" type="number" value="${escapeHtml(g.year || d.year || '')}"></div>
    <div class="field"><label for="a-label">Label</label><input id="a-label" type="text" value="${escapeHtml(d.label || '')}"></div>

    <div class="field"><label>Add to</label>
      <div class="dest">
        <button type="button" class="chip ${startView === 'library' ? 'on' : ''}" data-dest="library">Library</button>
        <button type="button" class="chip ${startView === 'shopping' ? 'on' : ''}" data-dest="shopping">Shopping list</button>
      </div>
    </div>

    <div class="field" id="a-format-field" ${startView === 'shopping' ? 'hidden' : ''}><label>Format</label>
      <div class="chips" id="a-formats">
        ${FORMATS.map((f) => `<button type="button" class="chip" data-f="${f}">${f}</button>`).join('')}
      </div>
    </div>

    <div class="field"><label for="a-art">Cover</label>
      ${draft.artBlob ? '<p class="hint">From the Cover Art Archive. Pick a file to replace it.</p>'
                      : '<p class="hint">No cover found. Pick one from your phone, or add it later.</p>'}
      <input id="a-art" type="file" accept="image/*">
      <img id="art-preview" ${draft.artBlob ? '' : 'hidden'} alt="">
    </div>

    <div class="field"><label>Tracklist</label>
      ${d.tracks.length ? `<p class="hint">${d.tracks.length} tracks from MusicBrainz.</p>` : '<p class="hint">None — can be filled later.</p>'}
    </div>

    <div class="field"><label>Saves as</label><p class="filename" id="a-filename">—</p></div>
    <button id="a-save" class="primary">Add album</button>
  </div>`;

  if (draft.artBlob) el('art-preview').src = URL.createObjectURL(draft.artBlob);
  const updateName = () => {
    const slug = slugify(`${el('a-artist').value} ${el('a-title').value}`);
    el('a-filename').textContent = slug ? `albums/${slug}.md` : '—';
  };
  el('a-title').oninput = updateName;
  el('a-artist').oninput = updateName;
  updateName();

  box.querySelectorAll('[data-dest]').forEach((c) => {
    c.onclick = () => {
      box.querySelectorAll('[data-dest]').forEach((o) => o.classList.toggle('on', o === c));
      el('a-format-field').hidden = c.dataset.dest === 'shopping';
    };
  });
  box.querySelectorAll('#a-formats .chip').forEach((c) => { c.onclick = () => c.classList.toggle('on'); });
  el('a-art').onchange = async (ev) => {
    const file = ev.target.files?.[0];
    if (!file) return;
    try {
      const { base64, blob } = await shrinkToJpegB64(file);
      draft.artB64 = base64; draft.artBlob = blob;
      el('art-preview').src = URL.createObjectURL(blob);
      el('art-preview').hidden = false;
      toast(`Cover ready — ${Math.round(blob.size / 1024)}KB`, 'good');
    } catch (err) {
      toast(`Could not read that image — ${err.message}`, 'bad');
    }
  };
  el('a-save').onclick = submitNewAlbum;
}

async function submitNewAlbum() {
  const value = (id) => (el(id)?.value || '').trim();
  const title = value('a-title');
  const artist = value('a-artist');
  if (!title || !artist) return toast('Album and artist are both needed', 'bad');

  const slug = slugify(`${artist} ${title}`);
  const existing = state.albums.find((a) => a.slug === slug);
  if (existing) {
    return toast(`Already in your ${existing.status === 'shopping' ? 'shopping list' : 'library'}`, 'bad');
  }

  const dest = el('a-form').querySelector('[data-dest].on')?.dataset.dest || 'library';
  const formats = dest === 'library'
    ? [...el('a-formats').querySelectorAll('.chip.on')].map((c) => c.dataset.f) : [];
  if (dest === 'library' && !formats.length) return toast('Pick a format, or add it to the shopping list', 'bad');

  const d = draft.details || { tracks: [], discs: 1 };
  const year = parseInt(value('a-year'), 10);
  const label = value('a-label');
  const hasArt = !!draft.artB64;
  const block = (k, arr) => (arr.length ? `${k}:\n${arr.map((v) => `- ${yamlValue(v)}`).join('\n')}` : `${k}: []`);

  const fm = [
    `title: ${yamlValue(title)}`,
    `artist: ${yamlValue(artist)}`,
    `status: ${dest}`,
    `release_year: ${Number.isInteger(year) ? year : 'null'}`,
    `label: ${label ? yamlValue(label) : 'null'}`,
    block('formats', formats),
    'quality: null',
    'genres: []',
    'rating: null',
    `artwork: ${hasArt ? `artwork/${slug}.jpg` : 'null'}`,
    `discs: ${d.discs || 1}`,
    `musicbrainz_id: ${draft.group ? draft.group.id : 'null'}`,
    `musicbrainz_release: ${d.releaseId || 'null'}`,
    ...renderTracks(d.tracks || []),
  ].join('\n');

  // Not isNew: if an earlier tap got the file onto GitHub before failing (or a
  // double tap), GitHub refuses a second create without the file's version id.
  // writeFile looks that id up, so a retry simply finishes the job.
  const btn = el('a-save');
  btn.disabled = true;
  btn.textContent = 'Saving…';
  const ok = await save('Adding album', async () => {
    await writeFile(`albums/${slug}.md`, joinFile(fm, ''), `Add ${artist} — ${title} to ${dest === 'library' ? 'library' : 'shopping list'}`);
    if (hasArt) {
      await writeFile(`artwork/${slug}.jpg`, null, `Cover for ${artist} — ${title}`, { base64: draft.artB64 });
      await forgetArt(`${slug}.jpg`);
    }
  });
  btn.disabled = false;
  btn.textContent = 'Add album';

  if (ok) {
    const totalSec = (d.tracks || []).reduce((s, t) => {
      const [m, sec] = String(t.length || '0:0').split(':').map(Number);
      return s + (m || 0) * 60 + (sec || 0);
    }, 0);
    const added = {
      slug, title, artist, status: dest,
      ...(Number.isInteger(year) ? { release_year: year } : {}),
      ...(label ? { label } : {}),
      ...(formats.length ? { formats } : {}),
      discs: d.discs || 1,
      track_count: (d.tracks || []).length,
      ...(totalSec ? { total_length: `${Math.floor(totalSec / 60)}:${String(totalSec % 60).padStart(2, '0')}` } : {}),
      ...(hasArt ? { artwork: `${slug}.jpg` } : {}),
      rating: null,
    };
    toast(`Added ${title}`, 'good');
    el('addalbum').hidden = true;
    draft = null;
    state.albums.push(added);
    state.albums.sort((a, b) => String(a.artist).localeCompare(String(b.artist)) ||
      (a.release_year || 0) - (b.release_year || 0));
    if (state.view !== dest) setView(dest); else renderAll();
  }
}

/* ── Sign in / boot ───────────────────────────────────────────────────── */

async function start() {
  el('signin').hidden = true;
  el('library').hidden = false;
  status('Loading…', 'saving');
  try {
    await loadCatalogue();
    status('');
    renderAll();
  } catch (err) {
    status('');
    el('grid').innerHTML =
      `<p class="error" style="grid-column:1/-1">Could not load the catalogue — ${escapeHtml(err.message)}
       <br><br>If this is a fresh repo, the index has not been built yet: push once so the
       Build index action runs, or run build_index.py and commit index.json.</p>`;
  }
}

function signOut() {
  Object.values(LS).forEach((k) => localStorage.removeItem(k));
  location.reload();
}
window.musicVaultSignOut = signOut;   // escape hatch from the console

document.addEventListener('DOMContentLoaded', () => {
  state.owner = localStorage.getItem(LS.owner) || '';
  state.repo = localStorage.getItem(LS.repo) || '';
  state.token = localStorage.getItem(LS.token) || '';
  try { if (localStorage.getItem(LS_VIEW) === 'shopping') state.view = 'shopping'; } catch { /* fine */ }

  el('btn-filters').onclick = () => { state.filtersOpen = !state.filtersOpen; renderFilters(); };
  el('btn-add').onclick = openAdd;
  el('btn-random').onclick = pickRandom;
  el('search').oninput = (e) => { state.filters.q = e.target.value; renderGrid(); };
  document.querySelectorAll('.tab').forEach((t) => { t.onclick = () => setView(t.dataset.view); });

  if (state.owner && state.repo && state.token) return start();

  el('signin').hidden = false;
  el('in-owner').value = state.owner;
  el('in-repo').value = state.repo;

  el('btn-signin').onclick = async () => {
    const owner = el('in-owner').value.trim();
    const repo = el('in-repo').value.trim();
    const token = el('in-token').value.trim();
    const err = el('signin-error');
    err.hidden = true;
    if (!owner || !repo || !token) { err.textContent = 'All three are needed.'; err.hidden = false; return; }

    el('btn-signin').disabled = true;
    el('btn-signin').textContent = 'Checking…';
    Object.assign(state, { owner, repo, token });
    try {
      const res = await fetch(`${API}/repos/${owner}/${repo}`, { headers: ghHeaders() });
      if (!res.ok) throw new Error(await ghError(res));
      localStorage.setItem(LS.owner, owner);
      localStorage.setItem(LS.repo, repo);
      localStorage.setItem(LS.token, token);
      start();
    } catch (e) {
      err.textContent = e.message;
      err.hidden = false;
    } finally {
      el('btn-signin').disabled = false;
      el('btn-signin').textContent = 'Sign in';
    }
  };
});
