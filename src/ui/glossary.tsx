/**
 * The glossary editor on the options page: names and terms, each with how it's said and how it
 * should be written. Edits are saved when a field loses focus or an entry is added or removed.
 */
import { type FormEvent, useEffect, useId, useState } from 'react';
import type { GlossaryEntry } from '@/engines/glossary';
import {
  MAX_GLOSSARY,
  MAX_GLOSSARY_TEXT,
  type Settings,
  type SettingsPatch,
} from '@/settings/settings';

type Row = GlossaryEntry & { key: number };

let nextKey = 1;
const withKeys = (entries: readonly GlossaryEntry[]): Row[] =>
  entries.map((e) => ({ ...e, key: nextKey++ }));

export function GlossaryEditor({
  settings,
  update,
}: {
  settings: Settings;
  update(patch: SettingsPatch): void;
}) {
  // Edited here, saved on blur: a save per keystroke would re-render every open page. Each row
  // has a key of its own, since both its fields can change.
  const [rows, setRows] = useState<Row[]>(() => withKeys(settings.glossary));
  const [source, setSource] = useState('');
  const [target, setTarget] = useState('');
  const sourceId = useId();
  const targetId = useId();
  useEffect(() => setRows(withKeys(settings.glossary)), [settings.glossary]);

  const save = (next: readonly Row[]) =>
    update({ glossary: next.map(({ source, target }) => ({ source, target })) });
  const edit = (index: number, patch: Partial<GlossaryEntry>) =>
    setRows((r) => r.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  const remove = (index: number) => save(rows.filter((_, i) => i !== index));
  const exists = rows.some((r) => r.source.trim() === source.trim());
  const full = rows.length >= MAX_GLOSSARY;
  const canAdd = source.trim() !== '' && target.trim() !== '' && !exists && !full;
  const add = (e: FormEvent) => {
    e.preventDefault();
    if (!canAdd) return;
    save([...rows, { source: source.trim(), target: target.trim(), key: nextKey++ }]);
    setSource('');
    setTarget('');
  };

  return (
    <div className="card px-4 py-3" data-testid="glossary">
      {rows.length > 0 && (
        <ul className="divide-y divide-[var(--color-line)]" aria-label="Glossary entries">
          {rows.map((row, i) => (
            <li key={row.key} className="flex flex-wrap items-center gap-2 py-2">
              <input
                className="input min-w-0 flex-1"
                aria-label="Said as"
                value={row.source}
                maxLength={MAX_GLOSSARY_TEXT}
                onChange={(e) => edit(i, { source: e.target.value })}
                onBlur={() => save(rows)}
              />
              <span aria-hidden="true" className="text-[var(--color-muted)]">
                →
              </span>
              <input
                className="input min-w-0 flex-1"
                aria-label="Written as"
                value={row.target}
                maxLength={MAX_GLOSSARY_TEXT}
                onChange={(e) => edit(i, { target: e.target.value })}
                onBlur={() => save(rows)}
              />
              <button
                type="button"
                className="btn btn-sm btn-quiet"
                aria-label={`Remove ${row.source}`}
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
        <div className="grid min-w-0 flex-1 gap-1">
          <label htmlFor={sourceId} className="text-[13px] text-[var(--color-muted)]">
            Said as
          </label>
          <input
            id={sourceId}
            className="input"
            value={source}
            maxLength={MAX_GLOSSARY_TEXT}
            placeholder="Camille"
            onChange={(e) => setSource(e.target.value)}
          />
        </div>
        <div className="grid min-w-0 flex-1 gap-1">
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
        <button type="submit" className="btn btn-sm" disabled={!canAdd} data-testid="glossary-add">
          Add
        </button>
      </form>
      {(exists || full) && (
        <p className="pt-2 text-[13px] text-[var(--color-muted)]">
          {full ? `The glossary is full (${MAX_GLOSSARY} entries).` : 'That one is already in.'}
        </p>
      )}
    </div>
  );
}
