const SGR = /^\x1b\[[0-9;:]{0,64}m/;
const STRING_INTRODUCERS = new Set([']', 'P', '_', '^', 'X']);
const C1_STRING_INTRODUCERS = new Set([0x90, 0x98, 0x9d, 0x9e, 0x9f]);
const BIDI_CONTROLS = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;

function stringTerminatorEnd(text: string, start: number): number {
  for (let i = start; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code === 0x07 || code === 0x9c) return i + 1;
    if (code === 0x1b && text[i + 1] === '\\') return i + 2;
  }
  return text.length;
}

function escapeEnd(text: string, start: number): number {
  const next = text[start + 1];
  if (next === undefined) return start + 1;
  if (next === '[') {
    const match = /^\x1b\[[0-?]*[ -/]*[@-~]/.exec(text.slice(start));
    return match ? start + match[0].length : text.length;
  }
  if (STRING_INTRODUCERS.has(next)) return stringTerminatorEnd(text, start + 2);
  if (next >= ' ' && next <= '/') {
    const match = /^\x1b[ -/]+[0-~]/.exec(text.slice(start));
    return match ? start + match[0].length : text.length;
  }
  return start + 2;
}

/**
 * Make text safe for one footer row: line breaks and tabs become spaces, and every terminal control
 * except SGR styling (`ESC [ … m`) is removed. SGR is kept only when `keepSgr` is set, and a reset is
 * appended so external styles cannot bleed into neighbouring modules.
 */
export function sanitizeInline(text: string, keepSgr: boolean): string {
  let out = '';
  let styled = false;
  let i = 0;
  while (i < text.length) {
    const code = text.charCodeAt(i);
    if (code === 0x1b) {
      const sgr = SGR.exec(text.slice(i));
      if (sgr) {
        if (keepSgr) { out += sgr[0]; styled = true; }
        i += sgr[0].length;
      } else i = escapeEnd(text, i);
      continue;
    }
    if (code === 0x9b) {
      const match = /^[0-?]*[ -/]*[@-~]/.exec(text.slice(i + 1));
      i = match ? i + 1 + match[0].length : text.length;
      continue;
    }
    if (C1_STRING_INTRODUCERS.has(code)) { i = stringTerminatorEnd(text, i + 1); continue; }
    if (code === 0x0a || code === 0x0d || code === 0x09 || code === 0x0b || code === 0x0c || code === 0x2028 || code === 0x2029) {
      out += ' ';
    } else if (!(code < 0x20 || code === 0x7f || (code >= 0x80 && code < 0xa0))) {
      out += text[i];
    }
    i++;
  }
  out = out.replace(BIDI_CONTROLS, '').replace(/ {2,}/g, ' ').trim();
  return styled && out ? out + '\x1b[0m' : out;
}
