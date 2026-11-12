/* Proves the surgical editors never disturb anything they weren't aimed at.
 *
 * Runs every editor the app uses over every real album file and asserts that
 * the ONLY lines that differ are the ones being targeted. A regression here
 * would quietly corrupt the collection, so this is the test worth having.
 *
 *   node test-frontmatter.js ../music-vault-data
 */

const fs = require('fs');
const path = require('path');
const FM = require('./frontmatter.js');

const dataDir = process.argv[2] || '../music-vault-data';
const albumsDir = path.join(dataDir, 'albums');
const files = fs.readdirSync(albumsDir).filter((f) => f.endsWith('.md'));

let checked = 0;
const failures = [];
const fail = (file, msg) => failures.push(`${file}: ${msg}`);

/** Lines present in `a` but not `b`, and vice versa (as multisets). */
function lineDiff(a, b) {
  const A = a.split('\n'), B = b.split('\n');
  const removed = [], added = [];
  const countOf = (arr) => arr.reduce((m, l) => m.set(l, (m.get(l) || 0) + 1), new Map());
  const ca = countOf(A), cb = countOf(B);
  for (const [l, n] of ca) { const d = n - (cb.get(l) || 0); for (let i = 0; i < d; i++) removed.push(l); }
  for (const [l, n] of cb) { const d = n - (ca.get(l) || 0); for (let i = 0; i < d; i++) added.push(l); }
  return { removed, added };
}

/** Same parser the app uses for tracks. */
function getTracks(fm) {
  const lines = fm.split('\n');
  const start = lines.findIndex((l) => /^tracks:\s*$/.test(l));
  if (start === -1) return [];
  const out = [];
  for (let i = start + 1; i < lines.length && /^-\s/.test(lines[i]); i++) out.push(JSON.parse(lines[i].slice(2)));
  return out;
}

for (const file of files) {
  const original = fs.readFileSync(path.join(albumsDir, file), 'utf8');
  let parts;
  try { parts = FM.splitFile(original); } catch { fail(file, 'no frontmatter'); continue; }
  checked++;

  // 1. Round trip with no change must be byte-identical.
  if (FM.joinFile(parts.fm, parts.body) !== original) fail(file, 'round trip altered the file');

  // 2. Rating: exactly the rating line changes.
  {
    const out = FM.joinFile(FM.setScalar(parts.fm, 'rating', 4.5), parts.body);
    const { removed, added } = lineDiff(original, out);
    if (added.length !== 1 || added[0] !== 'rating: 4.5') fail(file, `rating added ${JSON.stringify(added)}`);
    if (removed.length !== 1 || !removed[0].startsWith('rating:')) fail(file, `rating removed ${JSON.stringify(removed)}`);
  }

  // 3. Formats: only `formats:` lines change, and reading back gives what was set.
  {
    const want = ['FLAC', 'WAV'];
    const fm = FM.setList(parts.fm, 'formats', want);
    if (JSON.stringify(FM.getList(fm, 'formats')) !== JSON.stringify(want)) fail(file, 'formats did not read back');
    const { removed, added } = lineDiff(original, FM.joinFile(fm, parts.body));
    const ok = (l) => l.startsWith('formats:') || /^- (ALAC|FLAC|WAV|AIFF|MP3|AAC)$/.test(l);
    if (![...removed, ...added].every(ok)) fail(file, `formats touched other lines ${JSON.stringify([...removed, ...added])}`);
  }

  // 4. Move to library: status + formats in one edit, nothing else.
  {
    const fm = FM.setList(FM.setScalar(parts.fm, 'status', 'shopping'), 'formats', []);
    const back = FM.setList(FM.setScalar(fm, 'status', 'library'), 'formats', FM.getList(parts.fm, 'formats'));
    if (FM.joinFile(back, parts.body) !== original) fail(file, 'shopping → library round trip altered the file');
  }

  // 5. Tracks: replacing the block with itself is byte-identical, and every
  //    track line parses as JSON (what the app reads).
  {
    let tracks;
    try { tracks = getTracks(parts.fm); } catch (e) { fail(file, `track line not JSON: ${e.message}`); continue; }
    const rendered = tracks.length
      ? ['tracks:', ...tracks.map((t) => '- {' + Object.entries({ disc: t.disc || 1, number: t.number, title: t.title, length: t.length || null })
          .map(([k, v]) => `${JSON.stringify(k)}: ${JSON.stringify(v)}`).join(', ') + '}')]
      : ['tracks: []'];
    if (FM.joinFile(FM.setBlock(parts.fm, 'tracks', rendered), parts.body) !== original) {
      fail(file, 'rewriting tracks with the same tracks altered the file');
    }
    // An empty tracklist then refilled must also come back identical.
    const emptied = FM.setBlock(parts.fm, 'tracks', ['tracks: []']);
    if (getTracks(emptied).length) fail(file, 'emptying tracks left tracks behind');
    if (FM.joinFile(FM.setBlock(emptied, 'tracks', rendered), parts.body) !== original) {
      fail(file, 'refilling tracks altered the file');
    }
  }

  // 6. Notes: replacing the body never touches the frontmatter.
  {
    const out = FM.setBody(original, 'A note\n');
    if (FM.splitFile(out).fm !== parts.fm) fail(file, 'setBody changed frontmatter');
  }

  // 7. Genre (list of strings, may contain characters that need quoting).
  {
    const want = ['Post-rock', 'Lo-fi: home recordings'];
    const fm = FM.setList(parts.fm, 'genres', want);
    if (JSON.stringify(FM.getList(fm, 'genres')) !== JSON.stringify(want)) fail(file, 'genres did not read back');
  }
}

if (failures.length) {
  console.error(failures.slice(0, 40).join('\n'));
  console.error(`\n${failures.length} failure(s) across ${checked} albums`);
  process.exit(1);
}
console.log(`OK — ${checked} albums, every edit touched only its own lines`);
