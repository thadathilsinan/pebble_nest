import type { ChosenTrace } from '../core/database/schema';

/**
 * A block name as BLK-02 and DSH-04 compare it: capitals and surrounding
 * spaces ignored, so "Family" and " family " are one name. The same rule as
 * the app's `normaliseName` (`pebble_ui/lib/chart/patterns.dart`).
 */
export function normaliseBlockName(name: string): string {
  return name.trim().toLowerCase();
}

/**
 * Every trace the app draws with, in the order of its `Trace` enum, which the
 * hash below indexes into. `open` is last: a name can hash to it, but it can
 * never be chosen.
 */
const APP_TRACES = [
  'solid',
  'ruled',
  'verticalRuled',
  'grid',
  'stipple',
  'dotted',
  'dashed',
  'checker',
  'open',
] as const;

export type Trace = (typeof APP_TRACES)[number];

/**
 * The trace a normalised name is drawn in when no choice is stored: the app's
 * `_hashedTrace`, a 32-bit FNV-1a over the name's UTF-16 code units. It has to
 * match the app exactly, because choosing this trace is how a choice is
 * cleared.
 */
export function defaultTrace(nameKey: string): Trace {
  let h = 0x811c9dc5;
  for (let i = 0; i < nameKey.length; i++) {
    h ^= nameKey.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  const trace = APP_TRACES[h % APP_TRACES.length];
  if (trace === undefined) throw new Error('trace index out of range');
  return trace;
}

/**
 * The trace chosen for `name`, or null when the name keeps its default.
 * `chosen` is keyed by normalised name.
 */
export function chosenTraceFor(
  chosen: ReadonlyMap<string, ChosenTrace>,
  name: string,
): ChosenTrace | null {
  return chosen.get(normaliseBlockName(name)) ?? null;
}

/** Chosen traces keyed by normalised name, for `chosenTraceFor`. */
export function tracesByName(
  rows: readonly { nameKey: string; trace: ChosenTrace }[],
): Map<string, ChosenTrace> {
  return new Map(rows.map((row) => [row.nameKey, row.trace]));
}
