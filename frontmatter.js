/* Surgical frontmatter editing.
 *
 * Deliberately NOT a YAML library. Parsing to an object and re-serialising
 * would reorder keys and restyle lists — turning a one-tap rating change into
 * a whole-file rewrite and mangling files hand-edited in Typora or Obsidian.
 * Shared with Movie Vault. Everything here replaces only the lines it targets and
 * leaves every other byte untouched.
 *
 * Kept in its own file so it can be tested outside the browser.
 */

(function (root) {
  'use strict';

  const FM_RE = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/;

  function splitFile(text) {
    const m = text.match(FM_RE);
    if (!m) throw new Error('File has no frontmatter');
    return { fm: m[1], body: m[2] };
  }

  const joinFile = (fm, body) => `---\n${fm}\n---\n${body}`;

  /** Quote only when plain YAML would misread the value. */
  function yamlValue(v) {
    const s = String(v);
    const safe = /^[A-Za-z0-9][A-Za-z0-9 '&.\-\/()]*$/.test(s) && !/:\s/.test(s);
    return safe ? s : JSON.stringify(s);
  }

  const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  /**
   * Replace a single-line scalar in place. Only safe for keys whose value is on
   * one line — never use it for a value that folds across several lines.
   */
  function setScalar(fm, key, value) {
    const re = new RegExp(`^${escapeRe(key)}:.*$`, 'm');
    const line = `${key}: ${value}`;
    return re.test(fm) ? fm.replace(re, line) : `${fm}\n${line}`;
  }

  /**
   * Replace a block list (`genres:`, `watchlists:`) in place, keeping its
   * position. Handles both `key: []` and `key:` followed by `- item` lines.
   */
  function setList(fm, key, values) {
    const rendered = values.length
      ? [`${key}:`, ...values.map((v) => `- ${yamlValue(v)}`)]
      : [`${key}: []`];

    const head = new RegExp(`^${escapeRe(key)}:`);
    const lines = fm.split('\n');
    const out = [];
    let found = false;

    for (let i = 0; i < lines.length; i++) {
      if (!found && head.test(lines[i])) {
        found = true;
        out.push(...rendered);
        while (i + 1 < lines.length && /^\s*-\s+/.test(lines[i + 1])) i++;
        continue;
      }
      out.push(lines[i]);
    }
    if (!found) out.push(...rendered);
    return out.join('\n');
  }

  /**
   * Replace a whole top-level block with lines already rendered by the caller.
   * Used for `tracks:`, whose items are one-line flow maps that setList would
   * quote as strings. Everything from the key line to the next top-level key
   * (or the end) is replaced; nothing else moves.
   */
  function setBlock(fm, key, rendered) {
    const head = new RegExp(`^${escapeRe(key)}:`);
    const lines = fm.split('\n');
    const out = [];
    let found = false;
    for (let i = 0; i < lines.length; i++) {
      if (!found && head.test(lines[i])) {
        found = true;
        out.push(...rendered);
        while (i + 1 < lines.length && /^(\s+|-\s)/.test(lines[i + 1])) i++;
        continue;
      }
      out.push(lines[i]);
    }
    if (!found) out.push(...rendered);
    return out.join('\n');
  }

  /** Read a block list back out of raw frontmatter text. */
  function getList(fm, key) {
    const head = new RegExp(`^${escapeRe(key)}:`);
    const lines = fm.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (!head.test(lines[i])) continue;
      if (/\[\s*\]\s*$/.test(lines[i])) return [];
      const out = [];
      for (let j = i + 1; j < lines.length && /^\s*-\s+/.test(lines[j]); j++) {
        out.push(lines[j].replace(/^\s*-\s+/, '').replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1').trim());
      }
      return out;
    }
    return [];
  }

  /**
   * `copies:` on a film, `seasons:` on a series, are the only nested structures
   * in these files, so the flat helpers above cannot reach into them. Everything
   * below works on the line ranges of each entry, so editing one field leaves
   * the rest byte-identical. Both blocks have the same shape, hence the `key`.
   *
   *   copies:                  seasons:
   *   - format: Blu-ray        - season: 1            <- range starts
   *     distributor: Eureka      format: Blu-ray
   *     shelf_location: Shelf    shelf_location: Shelf  <- range ends
   */
  function copyRanges(fm, key = 'copies') {
    const head = new RegExp(`^${escapeRe(key)}:\\s*$`);
    const lines = fm.split('\n');
    const ranges = [];
    let inBlock = false;
    for (let i = 0; i < lines.length; i++) {
      if (!inBlock) {
        if (head.test(lines[i])) inBlock = true;             // `key: []` has none
        continue;
      }
      if (/^-\s+\S+:/.test(lines[i])) { ranges.push([i, i + 1]); continue; }
      if (/^\s+\S+:/.test(lines[i]) && ranges.length) { ranges[ranges.length - 1][1] = i + 1; continue; }
      break;                                                 // next top-level key
    }
    return { lines, ranges };
  }

  const unquote = (s) => {
    const v = s.trim();
    if (v === 'null' || v === '~' || v === '') return null;
    return v.replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1');
  };

  /** Read a copies or seasons block as an array of plain field objects. */
  function getCopies(fm, key = 'copies') {
    const { lines, ranges } = copyRanges(fm, key);
    return ranges.map(([a, b]) => {
      const fields = {};
      for (let i = a; i < b; i++) {
        const m = lines[i].match(/^(?:-\s+|\s+)(\S+):\s*(.*)$/);
        if (m) fields[m[1]] = unquote(m[2]);
      }
      return fields;
    });
  }

  /**
   * Set one field on one copy or season, in place. Writes `null` for an empty
   * value, and inserts the field if that entry does not carry it yet.
   */
  function setCopyField(fm, index, key, value, block = 'copies') {
    const { lines, ranges } = copyRanges(fm, block);
    const range = ranges[index];
    if (!range) return fm;
    const [a, b] = range;
    const rendered = (value === null || value === undefined || value === '') ? 'null' : yamlValue(value);
    for (let i = a; i < b; i++) {
      const m = lines[i].match(/^(-\s+|\s+)(\S+):/);
      if (m && m[2] === key) {
        lines[i] = `${m[1]}${key}: ${rendered}`;
        return lines.join('\n');
      }
    }
    lines.splice(a + 1, 0, `  ${key}: ${rendered}`);
    return lines.join('\n');
  }

  /** Replace the review body, leaving the frontmatter untouched. */
  function setBody(text, body) {
    const { fm } = splitFile(text);
    return joinFile(fm, body.replace(/\r\n/g, '\n'));
  }

  const api = { splitFile, joinFile, yamlValue, setScalar, setList, setBlock, getList, setBody,
                getCopies, setCopyField };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.FM = api;
})(typeof self !== 'undefined' ? self : this);
