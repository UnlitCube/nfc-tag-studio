// File-dialog filters for tag dumps, named in the UI language. One place, so the
// home screen, the binary editor and the backup screen show the same names for
// the same file types (2026-11-12 UX audit FLOW-16). FILE_FILTERS (shared/api)
// keeps the extensions; its `name` is a Japanese fallback only.
import { FILE_FILTERS } from '@shared/api';
import type { FileFilter } from '@shared/api';
import type { TFunc } from '../i18n';

export type DumpFilterKind = 'project' | 'bin' | 'flipper';

const DUMP_KINDS: readonly DumpFilterKind[] = ['project', 'bin', 'flipper'];

export function dumpFilter(t: TFunc, kind: DumpFilterKind): FileFilter {
  return { name: t(`file.filter.${kind}`), extensions: [...FILE_FILTERS[kind].extensions] };
}

/** For opening: every supported dump first (the dialog's default), then each format. */
export function dumpOpenFilters(t: TFunc): FileFilter[] {
  const all = DUMP_KINDS.flatMap((k) => [...FILE_FILTERS[k].extensions]);
  return [{ name: t('file.filter.all'), extensions: all }, ...DUMP_KINDS.map((k) => dumpFilter(t, k))];
}

/** The localized version of a FILE_FILTERS dump entry (e.g. EncodedDump.filter). */
export function localDumpFilter(t: TFunc, f: FileFilter): FileFilter {
  const kind = DUMP_KINDS.find((k) => FILE_FILTERS[k].extensions[0] === f.extensions[0]);
  return kind ? dumpFilter(t, kind) : { name: f.name, extensions: [...f.extensions] };
}
