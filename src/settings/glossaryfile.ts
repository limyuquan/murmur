/**
 * Glossary files, to share a glossary or keep a copy: JSON (what the options page exports, or a
 * plain list of entries) and tables, tab- or comma-separated, one entry per row:
 *
 *     said as | other spelling <TAB> written as <TAB> note
 *
 * `|` separates the ways a term is said; the note is optional. Empty rows, rows starting with `#`
 * and a header row are skipped; fields may be quoted ("a, b"), with `""` for a quote.
 */
import type { GlossaryEntry } from '@/engines/glossary';
import { cleanGlossary, MAX_GLOSSARY, MAX_GLOSSARY_ALIASES } from './settings';

export type GlossaryFormat = 'json' | 'tsv';

/** Largest glossary file read, bytes: a full glossary as JSON is about 150 kB. */
export const MAX_GLOSSARY_FILE_BYTES = 1_000_000;
/** Rows (or JSON entries) read from a file at most; the rest are left out. */
export const MAX_GLOSSARY_ROWS = MAX_GLOSSARY * 2;

/** The `format` field of an exported JSON glossary. */
export const GLOSSARY_FILE_FORMAT = 'murmur-glossary';

export interface ParsedGlossary {
  entries: GlossaryEntry[];
  /** Rows (1-based line numbers; JSON: 1-based entry numbers) that couldn't be read, and why. */
  skipped: { line: number; reason: string }[];
}

/**
 * Reads a glossary file. Never throws: what can't be read is in `skipped`. Text longer than
 * `MAX_GLOSSARY_FILE_BYTES` isn't read at all, and rows past `MAX_GLOSSARY_ROWS` are left out.
 */
export function parseGlossaryFile(text: string): ParsedGlossary {
  if (text.length > MAX_GLOSSARY_FILE_BYTES) {
    return { entries: [], skipped: [{ line: 0, reason: 'the file is too large' }] };
  }
  const body = text.replace(/^﻿/, '');
  const trimmed = body.trim();
  if (!trimmed) return { entries: [], skipped: [] };
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) return parseJson(trimmed);
  return parseTable(body);
}

/** A glossary as a file's text. */
export function formatGlossaryFile(
  entries: readonly GlossaryEntry[],
  format: GlossaryFormat,
): string {
  const clean = cleanGlossary(entries);
  if (format === 'json') {
    return `${JSON.stringify({ format: GLOSSARY_FILE_FORMAT, version: 1, entries: clean }, null, 2)}\n`;
  }
  const rows = clean.map((e) =>
    [[e.source, ...(e.aliases ?? [])].join('|'), e.target, e.note ?? ''].map(tsvField).join('\t'),
  );
  return `${['said as', 'written as', 'note'].join('\t')}\n${rows.map((r) => `${r}\n`).join('')}`;
}

export interface GlossaryMerge {
  entries: GlossaryEntry[];
  /** New entries. */
  added: number;
  /** Aliases (and notes) added to entries already there with the same rendering. */
  extended: number;
  /** Imported entries left out: every way they are said is already in, or the glossary is full. */
  unchanged: number;
}

/**
 * `incoming` added to `current`. An imported entry with the rendering of one already there adds
 * its aliases to it (and its note, if it has none); entries already there are never changed
 * otherwise.
 */
export function mergeGlossary(
  current: readonly GlossaryEntry[],
  incoming: readonly GlossaryEntry[],
): GlossaryMerge {
  const entries = cleanGlossary(current).map((e) => ({ ...e }));
  const byTarget = new Map(entries.map((e) => [e.target, e]));
  const said = new Set(entries.flatMap((e) => [e.source, ...(e.aliases ?? [])]));
  let added = 0;
  let extended = 0;
  let unchanged = 0;
  for (const raw of incoming) {
    const [entry] = cleanGlossary([raw]);
    if (!entry) {
      unchanged++;
      continue;
    }
    const fresh = [entry.source, ...(entry.aliases ?? [])].filter((a) => !said.has(a));
    const existing = byTarget.get(entry.target);
    if (existing) {
      const all = [existing.source, ...(existing.aliases ?? [])];
      const room = fresh.slice(0, Math.max(0, MAX_GLOSSARY_ALIASES - all.length));
      const note = !existing.note && entry.note ? entry.note : undefined;
      if (room.length === 0 && !note) {
        unchanged++;
        continue;
      }
      if (room.length > 0) existing.aliases = [...(existing.aliases ?? []), ...room];
      if (note) existing.note = note;
      for (const a of room) said.add(a);
      extended++;
      continue;
    }
    const [source, ...aliases] = fresh;
    if (!source || entries.length >= MAX_GLOSSARY) {
      unchanged++;
      continue;
    }
    const next: GlossaryEntry = {
      source,
      target: entry.target,
      ...(aliases.length > 0 ? { aliases } : {}),
      ...(entry.note ? { note: entry.note } : {}),
    };
    entries.push(next);
    byTarget.set(next.target, next);
    for (const a of fresh) said.add(a);
    added++;
  }
  return { entries, added, extended, unchanged };
}

function parseJson(text: string): ParsedGlossary {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { entries: [], skipped: [{ line: 0, reason: 'not valid JSON' }] };
  }
  const list = Array.isArray(data)
    ? data
    : isObject(data) && Array.isArray(data.entries)
      ? data.entries
      : null;
  if (!list) return { entries: [], skipped: [{ line: 0, reason: 'no list of entries' }] };
  const entries: GlossaryEntry[] = [];
  const skipped: ParsedGlossary['skipped'] = [];
  if (list.length > MAX_GLOSSARY_ROWS) {
    skipped.push({ line: MAX_GLOSSARY_ROWS + 1, reason: 'too many entries, the rest left out' });
  }
  list.slice(0, MAX_GLOSSARY_ROWS).forEach((item, i) => {
    if (!isObject(item)) {
      skipped.push({ line: i + 1, reason: 'not an entry' });
      return;
    }
    // `sources` (a list) is read too, the shape other tools tend to write.
    const sources = Array.isArray(item.sources) ? item.sources : [];
    const raw = {
      source: typeof item.source === 'string' ? item.source : '',
      aliases: [...sources, ...(Array.isArray(item.aliases) ? item.aliases : [])],
      target: item.target,
      note: item.note,
    };
    add(entries, skipped, i + 1, raw);
  });
  return { entries, skipped };
}

function parseTable(text: string): ParsedGlossary {
  const firstRow = text.split(/\r?\n/).find((l) => l.trim() && !l.trimStart().startsWith('#'));
  const delimiter = firstRow?.includes('\t') ? '\t' : ',';
  const entries: GlossaryEntry[] = [];
  const skipped: ParsedGlossary['skipped'] = [];
  let first = true;
  let rows = 0;
  for (const { line, fields } of readRows(text, delimiter)) {
    if (++rows > MAX_GLOSSARY_ROWS) {
      skipped.push({ line, reason: 'too many rows, the rest left out' });
      break;
    }
    const cells = fields.map((f) => unguard(f.trim()));
    if (cells.every((c) => !c) || (cells[0] ?? '').startsWith('#')) continue;
    if (first) {
      first = false;
      if (isHeader(cells)) continue;
    }
    if (cells.length < 2 || !cells[1]) {
      skipped.push({ line, reason: 'no "written as"' });
      continue;
    }
    add(entries, skipped, line, {
      source: '',
      aliases: (cells[0] ?? '').split('|'),
      target: cells[1],
      note: cells.slice(2).filter(Boolean).join(', '),
    });
  }
  return { entries, skipped };
}

function add(
  entries: GlossaryEntry[],
  skipped: ParsedGlossary['skipped'],
  line: number,
  raw: { source: string; aliases: unknown[]; target: unknown; note: unknown },
): void {
  const strings = [raw.source, ...raw.aliases].filter((a): a is string => typeof a === 'string');
  const [source = '', ...aliases] = strings.flatMap((a) => a.split('|')).filter((a) => a.trim());
  const [entry] = cleanGlossary([{ source, aliases, target: raw.target, note: raw.note }]);
  if (entry) entries.push(entry);
  else if (!source.trim()) skipped.push({ line, reason: 'no "said as"' });
  else if (typeof raw.target !== 'string' || !raw.target.trim()) {
    skipped.push({ line, reason: 'no "written as"' });
  } else skipped.push({ line, reason: 'too long' });
}

const HEADER_SAID = /^(said( as)?|sources?|alias(es)?|terms?)$/i;
const HEADER_WRITTEN = /^(written( as)?|targets?|renderings?|translations?)$/i;

function isHeader(cells: readonly string[]): boolean {
  return HEADER_SAID.test(cells[0] ?? '') && HEADER_WRITTEN.test(cells[1] ?? '');
}

/** Rows of a delimited text, with the line each starts on; quoted fields may hold anything. */
function* readRows(text: string, delimiter: string): Generator<{ line: number; fields: string[] }> {
  let line = 1;
  let i = 0;
  while (i < text.length) {
    const start = line;
    const fields: string[] = [];
    let field = '';
    let atFieldStart = true;
    for (;;) {
      if (i >= text.length) {
        fields.push(field);
        break;
      }
      const c = text[i] as string;
      if (atFieldStart && c === '"') {
        // Quoted: up to the closing quote; "" is a quote.
        i++;
        for (;;) {
          if (i >= text.length) break;
          const q = text[i] as string;
          if (q === '"') {
            if (text[i + 1] === '"') {
              field += '"';
              i += 2;
              continue;
            }
            i++;
            break;
          }
          if (q === '\n') line++;
          field += q;
          i++;
        }
        atFieldStart = false;
        continue;
      }
      atFieldStart = false;
      if (c === delimiter) {
        fields.push(field);
        field = '';
        atFieldStart = true;
        i++;
        continue;
      }
      if (c === '\n' || c === '\r') {
        fields.push(field);
        i += c === '\r' && text[i + 1] === '\n' ? 2 : 1;
        line++;
        break;
      }
      field += c;
      i++;
    }
    yield { line: start, fields };
  }
}

/**
 * A table cell. One a spreadsheet would read as a formula (starting `=`, `+`, `-` or `@`) gets a
 * leading `'`, which spreadsheets show as text and import takes off again (`unguard`).
 */
function tsvField(value: string): string {
  const flat = value.replace(/[\t\r\n]+/g, ' ');
  const safe = FORMULA_START.test(flat) ? `'${flat}` : flat;
  return safe.startsWith('"') ? `"${safe.replace(/"/g, '""')}"` : safe;
}

const FORMULA_START = /^[=+\-@]/;

/** A cell without the `'` an export put before what looks like a formula. */
function unguard(cell: string): string {
  return cell.startsWith("'") && FORMULA_START.test(cell.slice(1)) ? cell.slice(1) : cell;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
