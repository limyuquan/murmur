/**
 * The glossary editor on the options page: names and terms, each with the ways it's said (chips:
 * Enter or `|` after each), how it should be written and an optional note. Edits are saved when a
 * field loses focus, a way it's said is added or removed, or an entry is added or removed.
 * Glossaries are imported from and exported to files (settings/glossaryfile.ts).
 */
import {
  type ChangeEvent,
  type FormEvent,
  type KeyboardEvent,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react';
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
  type SettingsChange,
} from '@/settings/settings';
import { Icon, State } from './components';

/** One entry as edited: the ways it's said (the first is the main one). */
interface Row {
  key: number;
  said: string[];
  target: string;
  note: string;
}

let nextKey = 1;
const withKeys = (entries: readonly GlossaryEntry[]): Row[] =>
  entries.map((e) => ({
    key: nextKey++,
    said: [e.source, ...(e.aliases ?? [])],
    target: e.target,
    note: e.note ?? '',
  }));

/** Ways it's said from typed text (`|` between them), trimmed, none empty. */
const splitSaid = (said: string): string[] =>
  said
    .split('|')
    .map((a) => a.trim().slice(0, MAX_GLOSSARY_TEXT))
    .filter(Boolean);

/** `list` with `more` after it, each once, at most `MAX_GLOSSARY_ALIASES + 1`. */
const addSaid = (list: readonly string[], more: readonly string[]): string[] =>
  [...new Set([...list, ...more])].slice(0, MAX_GLOSSARY_ALIASES + 1);

function toEntry(row: Pick<Row, 'said' | 'target' | 'note'>): GlossaryEntry {
  const [source = '', ...aliases] = row.said;
  const note = row.note.trim();
  return {
    source,
    target: row.target.trim(),
    ...(aliases.length > 0 ? { aliases } : {}),
    ...(note ? { note } : {}),
  };
}

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * The ways an entry is said, as chips, with a field for one more: Enter, `|` or leaving the field
 * adds what was typed; Backspace in the empty field takes the last one out.
 */
function SaidInput({
  values,
  onChange,
  onDraft,
  id,
  label,
  placeholder,
}: {
  values: readonly string[];
  onChange(next: string[]): void;
  /** What is typed and not yet a chip (the add row takes it with the entry). */
  onDraft?: (text: string) => void;
  id?: string;
  label?: string;
  placeholder?: string;
}) {
  const [draft, setDraft] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const full = values.length > MAX_GLOSSARY_ALIASES;
  const setText = (text: string) => {
    setDraft(text);
    onDraft?.(text);
  };
  const commit = (text: string) => {
    const more = splitSaid(text);
    setText('');
    if (more.length > 0) onChange(addSaid(values, more));
  };
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && draft.trim()) {
      e.preventDefault();
      commit(draft);
    } else if (e.key === 'Backspace' && draft === '' && values.length > 0) {
      e.preventDefault();
      onChange(values.slice(0, -1));
    }
  };
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: a click on the box focuses its field.
    // biome-ignore lint/a11y/useKeyWithClickEvents: the field itself takes the keyboard.
    <div className="tokens" onClick={() => input.current?.focus()}>
      {values.map((v, i) => (
        <span key={v} className="token" data-main={i === 0}>
          <span>{v}</span>
          <button
            type="button"
            aria-label={`Remove “${v}”`}
            onClick={(e) => {
              e.stopPropagation();
              onChange(values.filter((x) => x !== v));
            }}
          >
            <Icon name="close" size={12} stroke={2.25} />
          </button>
        </span>
      ))}
      <input
        ref={input}
        id={id}
        aria-label={label}
        value={draft}
        maxLength={MAX_GLOSSARY_TEXT * 2}
        disabled={full && draft === ''}
        placeholder={values.length === 0 ? placeholder : full ? '' : 'Add another'}
        onChange={(e) => {
          const text = e.target.value;
          if (text.includes('|')) commit(text);
          else setText(text);
        }}
        onKeyDown={onKeyDown}
        onBlur={() => commit(draft)}
      />
    </div>
  );
}

export function GlossaryEditor({
  settings,
  update,
}: {
  settings: Settings;
  update(change: SettingsChange): void;
}) {
  // Edited here, saved on blur: a save per keystroke would re-render every open page. Each row
  // has a key of its own, since its fields can change.
  const [rows, setRows] = useState<Row[]>(() => withKeys(settings.glossary));
  const [said, setSaid] = useState<string[]>([]);
  const [saidDraft, setSaidDraft] = useState('');
  const [target, setTarget] = useState('');
  const [note, setNote] = useState('');
  const [message, setMessage] = useState<{ text: string; ok: boolean } | null>(null);
  const [addKey, setAddKey] = useState(0);
  const fileInput = useRef<HTMLInputElement>(null);
  const saidId = useId();
  const targetId = useId();
  const noteId = useId();
  useEffect(() => setRows(withKeys(settings.glossary)), [settings.glossary]);

  const save = (next: readonly Row[]) =>
    update({ glossary: next.filter((r) => r.said.length > 0).map(toEntry) });
  const edit = (index: number, patch: Partial<Row>) =>
    setRows((r) => r.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  const remove = (index: number) => save(rows.filter((_, i) => i !== index));
  const newSaid = addSaid(said, splitSaid(saidDraft));
  const taken = new Set(rows.flatMap((r) => r.said));
  const exists = newSaid.some((a) => taken.has(a));
  const full = rows.length >= MAX_GLOSSARY;
  const canAdd = newSaid.length > 0 && target.trim() !== '' && !exists && !full;
  const add = (e: FormEvent) => {
    e.preventDefault();
    if (!canAdd) return;
    save([...rows, { key: nextKey++, said: newSaid, target, note }]);
    setSaid([]);
    setSaidDraft('');
    // A fresh field for the next entry (it keeps its own draft).
    setAddKey((k) => k + 1);
    setTarget('');
    setNote('');
    setMessage(null);
  };

  const importFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (file.size > MAX_GLOSSARY_FILE_BYTES) {
      setMessage({
        ok: false,
        text: `${file.name} is too large for a glossary (over ${MAX_GLOSSARY_FILE_BYTES / 1_000_000}\u00a0MB). Choose a JSON, TSV or CSV glossary file.`,
      });
      return;
    }
    const parsed = parseGlossaryFile(await file.text());
    const merged = mergeGlossary(rows.map(toEntry), parsed.entries);
    // Merged into the stored glossary when written (the counts below are from this page's copy).
    if (merged.added > 0 || merged.extended > 0) {
      update((current) => ({ glossary: mergeGlossary(current.glossary, parsed.entries).entries }));
    }
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
    setMessage({
      ok: merged.added > 0 || merged.extended > 0,
      text: parts.join(' ') || `Nothing to import from ${file.name}.`,
    });
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
    <div className="card" data-testid="glossary">
      {rows.length > 0 && (
        <>
          <div className="gloss-grid head" aria-hidden="true">
            <span className="field-label">Said as</span>
            <span />
            <span className="field-label">Written as</span>
            <span className="field-label">Note</span>
            <span />
          </div>
          <ul aria-label="Glossary entries">
            {rows.map((row, i) => (
              <li key={row.key} className="gloss-grid" data-testid="glossary-entry">
                <SaidInput
                  label="Said as"
                  values={row.said}
                  onChange={(next) => {
                    // An entry keeps at least its main way of saying it.
                    if (next.length === 0) return;
                    const all = rows.map((r, j) => (j === i ? { ...r, said: next } : r));
                    setRows(all);
                    save(all);
                  }}
                />
                <span className="arrow" aria-hidden="true">
                  <Icon name="arrow" />
                </span>
                <input
                  className="input"
                  aria-label="Written as"
                  value={row.target}
                  maxLength={MAX_GLOSSARY_TEXT}
                  onChange={(e) => edit(i, { target: e.target.value })}
                  onBlur={() => save(rows)}
                />
                <input
                  className="input"
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
                  aria-label={`Remove ${row.said[0] ?? row.target}`}
                  onClick={() => remove(i)}
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
      <form onSubmit={add} className={rows.length > 0 ? 'gloss-grid add after' : 'gloss-grid add'}>
        <div className="stack g1">
          <label htmlFor={saidId} className="field-label">
            Said as
          </label>
          <SaidInput
            key={addKey}
            id={saidId}
            values={said}
            onChange={setSaid}
            onDraft={setSaidDraft}
            placeholder="Camille | Kamille"
          />
        </div>
        <span className="arrow" aria-hidden="true">
          <Icon name="arrow" />
        </span>
        <div className="stack g1">
          <label htmlFor={targetId} className="field-label">
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
        <div className="stack g1">
          <label htmlFor={noteId} className="field-label">
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
        <button type="submit" className="btn" disabled={!canAdd} data-testid="glossary-add">
          Add
        </button>
      </form>
      <p className="t-small muted gloss-hint">
        {full
          ? `The glossary is full (${MAX_GLOSSARY} entries).`
          : exists
            ? 'That one is already in.'
            : 'Press Enter after each way it’s said or misheard, in any script; the first is the main one. The note goes to the translator with the entry.'}
      </p>
      <div className="card-foot wrap">
        <span className="row g2">
          <button type="button" className="btn btn-sm" onClick={() => fileInput.current?.click()}>
            <Icon name="upload" /> Import…
          </button>
          <button
            type="button"
            className="btn btn-sm"
            disabled={rows.length === 0}
            onClick={() => exportFile('json')}
          >
            <Icon name="download" /> Export JSON
          </button>
          <button
            type="button"
            className="btn btn-sm"
            disabled={rows.length === 0}
            onClick={() => exportFile('tsv')}
          >
            <Icon name="download" /> Export TSV
          </button>
          <input
            ref={fileInput}
            type="file"
            className="sr-only"
            tabIndex={-1}
            aria-label="Glossary file"
            accept=".json,.tsv,.csv,.txt,application/json,text/csv,text/tab-separated-values,text/plain"
            onChange={importFile}
          />
        </span>
        {message && (
          <p role="status">
            <State tone={message.ok ? 'success' : 'behind'} icon={message.ok ? 'check' : 'info'}>
              {message.text}
            </State>
          </p>
        )}
        <p className="t-small muted foot-note">
          Files are JSON, or one entry per row: ways it’s said (| between them), how it’s written
          and a note, separated by tabs or commas.
        </p>
      </div>
    </div>
  );
}
