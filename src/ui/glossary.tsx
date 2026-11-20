/**
 * The glossary editor on the options page: names and terms, each with the ways it's said (`|`
 * between them), how it should be written and an optional note. Edits are saved when a field
 * loses focus or an entry is added or removed. Glossaries are imported from and exported to
 * files (settings/glossaryfile.ts).
 */
import { type ChangeEvent, type FormEvent, useEffect, useId, useRef, useState } from 'react';
import type { GlossaryEntry } from '@/engines/glossary';
import {
  formatGlossaryFile,
  type GlossaryFormat,
  MAX_GLOSSARY_FILE_BYTES,
  mergeGlossary,
  parseGlossaryFile,
} from '@/settings/glossaryfile';
import {
  MAX_GLOSSARY,
  MAX_GLOSSARY_ALIASES,
  MAX_GLOSSARY_TEXT,
  type Settings,
  type SettingsPatch,
} from '@/settings/settings';

/** One entry as edited: the ways it's said as one text, `|` between them. */
interface Row {
  key: number;
  said: string;
  target: string;
  note: string;
}

/** Room for every alias of an entry, with ` | ` between them. */
const SAID_MAX = (MAX_GLOSSARY_TEXT + 3) * MAX_GLOSSARY_ALIASES;

let nextKey = 1;
const withKeys = (entries: readonly GlossaryEntry[]): Row[] =>
  entries.map((e) => ({
    key: nextKey++,
    said: [e.source, ...(e.aliases ?? [])].join(' | '),
    target: e.target,
    note: e.note ?? '',
  }));

const splitSaid = (said: string): string[] =>
  said
    .split('|')
    .map((a) => a.trim())
    .filter(Boolean);

function toEntry(row: Pick<Row, 'said' | 'target' | 'note'>): GlossaryEntry {
  const [source = '', ...aliases] = splitSaid(row.said);
  const note = row.note.trim();
  return {
    source,
    target: row.target.trim(),
    ...(aliases.length > 0 ? { aliases } : {}),
    ...(note ? { note } : {}),
  };
}

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export function GlossaryEditor({
  settings,
  update,
}: {
  settings: Settings;
  update(patch: SettingsPatch): void;
}) {
  // Edited here, saved on blur: a save per keystroke would re-render every open page. Each row
  // has a key of its own, since its fields can change.
  const [rows, setRows] = useState<Row[]>(() => withKeys(settings.glossary));
  const [said, setSaid] = useState('');
  const [target, setTarget] = useState('');
  const [note, setNote] = useState('');
  const [message, setMessage] = useState('');
  const fileInput = useRef<HTMLInputElement>(null);
  const saidId = useId();
  const targetId = useId();
  const noteId = useId();
  useEffect(() => setRows(withKeys(settings.glossary)), [settings.glossary]);

  const save = (next: readonly Row[]) => update({ glossary: next.map(toEntry) });
  const edit = (index: number, patch: Partial<Row>) =>
    setRows((r) => r.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  const remove = (index: number) => save(rows.filter((_, i) => i !== index));
  const taken = new Set(rows.flatMap((r) => splitSaid(r.said)));
  const exists = splitSaid(said).some((a) => taken.has(a));
  const full = rows.length >= MAX_GLOSSARY;
  const canAdd = splitSaid(said).length > 0 && target.trim() !== '' && !exists && !full;
  const add = (e: FormEvent) => {
    e.preventDefault();
    if (!canAdd) return;
    save([...rows, { key: nextKey++, said, target, note }]);
    setSaid('');
    setTarget('');
    setNote('');
    setMessage('');
  };

  const importFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (file.size > MAX_GLOSSARY_FILE_BYTES) {
      setMessage(
        `${file.name} is too large for a glossary (over ${MAX_GLOSSARY_FILE_BYTES / 1_000_000}\u00a0MB). Choose a JSON, TSV or CSV glossary file.`,
      );
      return;
    }
    const parsed = parseGlossaryFile(await file.text());
    const merged = mergeGlossary(rows.map(toEntry), parsed.entries);
    if (merged.added > 0 || merged.extended > 0) update({ glossary: merged.entries });
    const parts: string[] = [];
    if (merged.added > 0) parts.push(`Added ${count(merged.added, 'entry', 'entries')}.`);
    if (merged.extended > 0) {
      parts.push(`Added spellings or notes to ${count(merged.extended, 'entry', 'entries')}.`);
    }
    if (merged.unchanged > 0) {
      parts.push(
        `${count(merged.unchanged, 'entry was', 'entries were')} already in${
          merged.entries.length >= MAX_GLOSSARY ? ' or didn’t fit' : ''
        }.`,
      );
    }
    if (parsed.skipped.length > 0) {
      const shown = parsed.skipped
        .slice(0, 3)
        .map((s) => (s.line > 0 ? `line ${s.line}: ${s.reason}` : s.reason))
        .join('; ');
      const more = parsed.skipped.length > 3 ? `; ${parsed.skipped.length - 3} more` : '';
      parts.push(`Skipped ${shown}${more}.`);
    }
    setMessage(parts.join(' ') || `Nothing to import from ${file.name}.`);
  };

  const exportFile = (format: GlossaryFormat) => {
    const text = formatGlossaryFile(rows.map(toEntry), format);
    const type = format === 'json' ? 'application/json' : 'text/tab-separated-values';
    const href = URL.createObjectURL(new Blob([text], { type }));
    const a = document.createElement('a');
    a.href = href;
    a.download = `murmur-glossary.${format}`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(href), 1000);
  };

  return (
    <div className="card px-4 py-3" data-testid="glossary">
      {rows.length > 0 && (
        <ul className="divide-y divide-[var(--color-line)]" aria-label="Glossary entries">
          {rows.map((row, i) => (
            <li key={row.key} className="flex flex-wrap items-center gap-2 py-2">
              <input
                className="input min-w-0 flex-[2]"
                aria-label="Said as"
                value={row.said}
                maxLength={SAID_MAX}
                onChange={(e) => edit(i, { said: e.target.value })}
                onBlur={() => save(rows)}
              />
              <span aria-hidden="true" className="text-[var(--color-muted)]">
                →
              </span>
              <input
                className="input min-w-0 flex-[2]"
                aria-label="Written as"
                value={row.target}
                maxLength={MAX_GLOSSARY_TEXT}
                onChange={(e) => edit(i, { target: e.target.value })}
                onBlur={() => save(rows)}
              />
              <input
                className="input min-w-0 flex-1"
                aria-label="Note"
                value={row.note}
                maxLength={MAX_GLOSSARY_TEXT}
                placeholder="Note"
                onChange={(e) => edit(i, { note: e.target.value })}
                onBlur={() => save(rows)}
              />
              <button
                type="button"
                className="btn btn-sm btn-quiet"
                aria-label={`Remove ${splitSaid(row.said)[0] ?? row.target}`}
                onClick={() => remove(i)}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
      <form
        onSubmit={add}
        className={`flex flex-wrap items-end gap-2 ${rows.length > 0 ? 'divider pt-3' : ''}`}
      >
        <div className="grid min-w-0 flex-[2] gap-1">
          <label htmlFor={saidId} className="text-[13px] text-[var(--color-muted)]">
            Said as
          </label>
          <input
            id={saidId}
            className="input"
            value={said}
            maxLength={SAID_MAX}
            placeholder="Camille | Kamille"
            onChange={(e) => setSaid(e.target.value)}
          />
        </div>
        <div className="grid min-w-0 flex-[2] gap-1">
          <label htmlFor={targetId} className="text-[13px] text-[var(--color-muted)]">
            Written as
          </label>
          <input
            id={targetId}
            className="input"
            value={target}
            maxLength={MAX_GLOSSARY_TEXT}
            placeholder="Camille"
            onChange={(e) => setTarget(e.target.value)}
          />
        </div>
        <div className="grid min-w-0 flex-1 gap-1">
          <label htmlFor={noteId} className="text-[13px] text-[var(--color-muted)]">
            Note
          </label>
          <input
            id={noteId}
            className="input"
            value={note}
            maxLength={MAX_GLOSSARY_TEXT}
            placeholder="Optional"
            onChange={(e) => setNote(e.target.value)}
          />
        </div>
        <button type="submit" className="btn btn-sm" disabled={!canAdd} data-testid="glossary-add">
          Add
        </button>
      </form>
      <p className="pt-2 text-[13px] text-[var(--color-muted)]">
        {full
          ? `The glossary is full (${MAX_GLOSSARY} entries).`
          : exists
            ? 'That one is already in.'
            : 'Put | between other ways it’s said or misheard, in any script. The note goes to the translator with the entry.'}
      </p>
      <div className="divider mt-3 flex flex-wrap items-center gap-2 pt-3">
        <button type="button" className="btn btn-sm" onClick={() => fileInput.current?.click()}>
          Import…
        </button>
        <button
          type="button"
          className="btn btn-sm"
          disabled={rows.length === 0}
          onClick={() => exportFile('json')}
        >
          Export JSON
        </button>
        <button
          type="button"
          className="btn btn-sm"
          disabled={rows.length === 0}
          onClick={() => exportFile('tsv')}
        >
          Export TSV
        </button>
        <input
          ref={fileInput}
          type="file"
          className="hidden"
          aria-label="Glossary file"
          accept=".json,.tsv,.csv,.txt,application/json,text/csv,text/tab-separated-values,text/plain"
          onChange={importFile}
        />
      </div>
      {message && (
        <p className="pt-2 text-[13px] text-[var(--color-muted)]" role="status">
          {message}
        </p>
      )}
      <p className="pt-2 text-[13px] text-[var(--color-muted)]">
        Files are JSON, or one entry per row: ways it’s said (| between them), how it’s written and
        a note, separated by tabs or commas.
      </p>
    </div>
  );
}
