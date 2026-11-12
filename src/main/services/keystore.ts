// MIFARE Classic key store. Integrator-owned.
//
// Keys are managed by the OPERATOR (invariant I3). This app never recovers or
// cracks keys. The three shipped keys are PUBLIC standard values only:
//   - factory default   FFFFFFFFFFFF
//   - NFC Forum MAD key  A0A1A2A3A4A5
//   - NFC Forum NDEF key D3F7D3F7D3F7
// User keys are persisted to userData/keys.json, encrypted with the OS keystore
// (safeStorage / DPAPI on Windows) when available. Key bytes never leave main:
// listKeys() returns only masked labels (I4).
import { safeStorage } from 'electron';
import type { MifareKeyEntry } from '@shared/types';
import { bytesToHex, hexToBytes } from '@shared/hex';
import type { ResolvedKey } from '../nfc/contract';
import { OpError } from '../errors';
import { readBytes, writeBytes } from './storage';

const FILE = 'keys.json';

const BUILTIN: { id: string; label: string; keyHex: string }[] = [
  { id: 'builtin-default', label: '工場出荷時 (FFFFFFFFFFFF)', keyHex: 'FFFFFFFFFFFF' },
  { id: 'builtin-mad', label: 'NFC Forum MAD 鍵', keyHex: 'A0A1A2A3A4A5' },
  { id: 'builtin-ndef', label: 'NFC Forum NDEF 鍵', keyHex: 'D3F7D3F7D3F7' },
];

interface StoredKey {
  id: string;
  label: string;
  keyHex: string;
}

function mask(keyHex: string): string {
  const h = keyHex.toUpperCase();
  if (h.length !== 12) return '••••••••••••';
  return `${h.slice(0, 2)}••••••••${h.slice(10)}`;
}

function toEntry(k: { id: string; label: string; keyHex: string }, builtin: boolean): MifareKeyEntry {
  return { id: k.id, label: k.label, masked: mask(k.keyHex), builtin };
}

export interface KeyStore {
  list(): MifareKeyEntry[];
  add(input: { label: string; keyHex: string }): Promise<MifareKeyEntry>;
  remove(id: string): Promise<void>;
  /** Resolve ids to raw key bytes (skips unknown ids). Order preserved. */
  resolve(ids: string[]): ResolvedKey[];
  /** All keys (builtin first, then user) - used as the default try-set for reads. */
  allIds(): string[];
}

async function load(): Promise<StoredKey[]> {
  const bytes = await readBytes(FILE);
  if (!bytes) return [];
  try {
    let text: string;
    // File format: { enc: boolean, data: base64 | json }
    const outer = JSON.parse(new TextDecoder().decode(bytes)) as { enc: boolean; data: string };
    if (outer.enc && safeStorage.isEncryptionAvailable()) {
      text = safeStorage.decryptString(Buffer.from(outer.data, 'base64'));
    } else if (!outer.enc) {
      text = outer.data;
    } else {
      return []; // encrypted but no key available (different machine/user)
    }
    const arr = JSON.parse(text) as StoredKey[];
    return Array.isArray(arr) ? arr.filter((k) => /^[0-9a-fA-F]{12}$/.test(k.keyHex)) : [];
  } catch {
    return [];
  }
}

async function persist(keys: StoredKey[]): Promise<void> {
  const text = JSON.stringify(keys);
  let outer: { enc: boolean; data: string };
  if (safeStorage.isEncryptionAvailable()) {
    outer = { enc: true, data: safeStorage.encryptString(text).toString('base64') };
  } else {
    outer = { enc: false, data: text };
  }
  await writeBytes(FILE, new TextEncoder().encode(JSON.stringify(outer)));
}

export async function createKeyStore(): Promise<KeyStore> {
  let user = await load();

  const byId = (id: string): StoredKey | undefined =>
    BUILTIN.find((k) => k.id === id) ?? user.find((k) => k.id === id);

  return {
    list() {
      return [...BUILTIN.map((k) => toEntry(k, true)), ...user.map((k) => toEntry(k, false))];
    },
    async add({ label, keyHex }) {
      const clean = keyHex.replace(/[^0-9a-fA-F]/g, '').toUpperCase();
      // OpError: the renderer gets "invalid input" with the code, not "unexpected error" (FIRST-9).
      // The detail never contains the key (I4).
      if (clean.length !== 12) throw new OpError('INVALID_INPUT', 'key must be 6 bytes (12 hex digits)');
      // hexToBytes validates; throws on bad input.
      hexToBytes(clean);
      const id = `key-${bytesToHex(crypto.getRandomValues(new Uint8Array(6)))}`;
      const entry: StoredKey = { id, label: label.trim() || `鍵 ${user.length + 1}`, keyHex: clean };
      user = [...user, entry];
      await persist(user);
      return toEntry(entry, false);
    },
    async remove(id) {
      if (BUILTIN.some((k) => k.id === id)) throw new OpError('INVALID_INPUT', 'built-in keys cannot be removed');
      user = user.filter((k) => k.id !== id);
      await persist(user);
    },
    resolve(ids) {
      const out: ResolvedKey[] = [];
      for (const id of ids) {
        const k = byId(id);
        if (k) out.push({ id: k.id, label: k.label, key: hexToBytes(k.keyHex) });
      }
      return out;
    },
    allIds() {
      return [...BUILTIN.map((k) => k.id), ...user.map((k) => k.id)];
    },
  };
}
