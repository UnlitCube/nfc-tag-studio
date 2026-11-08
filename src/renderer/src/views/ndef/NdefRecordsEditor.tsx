// Reusable NDEF record list editor. Props are a CONTRACT (frozen): used by the
// NDEF view and by the issue view (NDEF templates with placeholders).
// Owner: agent "renderer-ndef" - replace the body with the real editor.
import type { TagKind } from '@shared/tags';
import type { NdefRecordDraft } from '@shared/ndef/types';

export interface NdefRecordsEditorProps {
  records: NdefRecordDraft[];
  onChange: (records: NdefRecordDraft[]) => void;
  /** Show placeholder helpers ({{seq}}, {{uid}}, {{date}}, {{csv:..}}, {{input:..}}) for issue templates. */
  allowPlaceholders?: boolean;
  /** Tag kind for the capacity meter (null/undefined = hide the meter). */
  capacityKind?: TagKind | null;
  readOnly?: boolean;
}

export function NdefRecordsEditor(props: NdefRecordsEditorProps) {
  void props;
  return <div className="muted">NdefRecordsEditor (not implemented yet)</div>;
}
