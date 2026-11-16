// What kind of card is on the reader, as the screens say it (2026-11-14). The facts come
// from shared/cardType.ts (the ATR only; nothing is sent to the card). Used by the home
// screen's "tag on the reader" panel and by <TagOnReader /> for an unsupported card.
import type { ReactNode } from 'react';
import type { CardTypeInfo } from '@shared/cardType';
import type { TFunc } from '../i18n';
import { useT } from '../i18n';
import { KeyValue } from './ui';

/** "マイナンバーカード（ATR から推定）", "MIFARE Classic 1K", or null when the product is not known. */
export function cardProductText(t: TFunc, info: CardTypeInfo): string | null {
  if (!info.product) return null;
  const name = t(`cardType.product.${info.product}`);
  return info.productByAtr ? t('cardType.byAtr', { name }) : name;
}

/** "ISO/IEC 14443 Type B（推定）", "ISO/IEC 14443 Type A・NFC Forum Type 2", or null when unknown. */
export function cardRadioText(t: TFunc, info: CardTypeInfo): string | null {
  if (info.radio === 'unknown') return null;
  const radio = t(`cardType.radio.${info.radio}`);
  if (info.radioGuessed) return t('cardType.radio.guessed', { radio });
  return info.nfcType ? t('cardType.radio.nfcType', { radio, n: info.nfcType }) : radio;
}

/** A short name for a status line ("マイナンバーカード", "IC カード"), or null. */
export function cardShortName(t: TFunc, info: CardTypeInfo | null): string | null {
  if (!info) return null;
  if (info.product) return t(`cardType.product.${info.product}`);
  return info.form === 'smartcard' ? t('cardType.short.smartcard') : null;
}

/** "ATR 3B 88 80 01 ..." grouped by byte. */
function atrText(hex: string): string {
  return (hex.match(/.{1,2}/g) ?? []).join(' ');
}

export function CardTypeDetails({ info, showAtr = false }: { info: CardTypeInfo; showAtr?: boolean }) {
  const t = useT();
  const product = cardProductText(t, info);
  const radio = cardRadioText(t, info);
  const items: [string, ReactNode][] = [];
  if (product) items.push([t('cardType.label.card'), <span key="p" data-testid="card-type-product">{product}</span>]);
  items.push([t('cardType.label.radio'), <span key="r" data-testid="card-type-radio">{radio ?? t('cardType.unknown')}</span>]);
  if (info.form !== 'unknown') {
    items.push([t('cardType.label.form'), <span key="f" data-testid="card-type-form">{t(`cardType.form.${info.form}`)}</span>]);
  }
  if (showAtr && info.atr) {
    items.push([
      t('cardType.label.atr'),
      <span key="a" className="mono small" data-testid="card-type-atr" title={t('cardType.atrHint')}>
        {atrText(info.atr)}
      </span>,
    ]);
  }
  return (
    <div className="card-type" data-testid="card-type" data-form={info.form} data-radio={info.radio}>
      <KeyValue items={items} />
    </div>
  );
}
