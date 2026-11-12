// Tag image helpers, write planning, NTAG config / MIFARE trailer codecs and dump
// file formats - PUBLIC API (signatures frozen by the integrator).
// Owner: agent "shared-tag". Implementation lives in sibling modules (image.ts,
// plan.ts, ntag.ts, mifare.ts, dump-project.ts, dump-bin.ts, dump-flipper.ts,
// dump.ts) and is re-exported here. Names/parameters/return types are unchanged.
//
// Pure TypeScript: no Node, no DOM. Basic layout facts live in ../tags.ts
// (integrator-owned) - these modules build on them, they do not duplicate them.

// --- Image helpers ---
export { blankImage, cloneImage, unitBytes, diffUnits, isBlankDataArea } from './image';

// --- Write planning ---
export { planWrites, lockedUnitsOf } from './plan';
export type { PlanWarningCode, PlanWarning, WritePlan } from './plan';

// --- NTAG21x configuration ---
export {
  readNtagConfig,
  buildNtagConfigWrites,
  readNtagLockState,
  buildNtagPasswordWrites,
  buildNtagRemovePasswordWrites,
  buildNtagCounterWrites,
  buildNtagLockUserAreaWrites,
} from './ntag';
export type { NtagConfig, NtagLockState } from './ntag';

// --- MIFARE Classic ---
export { describeAccess, buildTrailer } from './mifare';
export type { AccessDescription } from './mifare';

// --- Dump file formats ---
export { serializeProject, parseProject } from './dump-project';
export { exportBin, importBin } from './dump-bin';
export { exportFlipper, importFlipper } from './dump-flipper';
export { detectDumpFormat, importDump } from './dump';
export type { DumpFormat } from './dump';
