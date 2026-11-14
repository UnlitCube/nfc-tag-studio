// D14 (2026-11-13): the one way back to the start of an editing / operation screen
// (binary editor, NDEF editor, backup & duplicate, erase). Always at the bottom,
// right next to (left of) the screen's main action, with the same words everywhere:
//   unsaved changes -> 「キャンセル」 (asks before discarding them)
//   nothing unsaved  -> 「閉じる」
// The screen passes what "back to the start" means for it (close the document,
// drop the NDEF draft, forget the tag read for erasing). Owner: renderer-core.
import { X } from 'lucide-react';
import { useT } from '../i18n';
import { Button } from './ui';

export function ExitButton({
  dirty,
  disabled,
  onExit,
  testId,
}: {
  /** There are unsaved changes: the label is 「キャンセル」 and onExit must ask before discarding them. */
  dirty: boolean;
  disabled?: boolean;
  onExit: () => void;
  testId: string;
}) {
  const t = useT();
  return (
    <Button
      variant="secondary"
      icon={X}
      disabled={disabled}
      title={t(dirty ? 'common.exit.cancelTip' : 'common.exit.closeTip')}
      data-testid={testId}
      data-exit-kind={dirty ? 'cancel' : 'close'}
      onClick={(e) => {
        if (e.detail > 1) return;
        onExit();
      }}
    >
      {t(dirty ? 'common.exit.cancel' : 'common.exit.close')}
    </Button>
  );
}
