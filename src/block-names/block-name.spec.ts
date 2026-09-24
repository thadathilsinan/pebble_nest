import { chosenTraceFor, defaultTrace, normaliseBlockName } from './block-name';

describe('normaliseBlockName', () => {
  it('ignores capitals and surrounding spaces', () => {
    expect(normaliseBlockName('  Deep Work ')).toBe('deep work');
  });
});

describe('defaultTrace', () => {
  // Printed by the app's own `_hashedTrace` (pebble_ui/lib/chart/patterns.dart).
  it.each([
    ['family', 'solid'],
    ['gym', 'dashed'],
    ['deep work', 'solid'],
    ['reading', 'open'],
    ['sleep', 'verticalRuled'],
    ['café', 'ruled'],
    ['a', 'checker'],
    ['commute', 'solid'],
    ['lunch', 'ruled'],
    ['🧘 yoga', 'checker'],
  ])('hashes %j to %s, as the app does', (name, trace) => {
    expect(defaultTrace(name)).toBe(trace);
  });
});

describe('chosenTraceFor', () => {
  it('looks the name up normalised, and is null without a choice', () => {
    const chosen = new Map([['family', 'grid' as const]]);

    expect(chosenTraceFor(chosen, ' Family')).toBe('grid');
    expect(chosenTraceFor(chosen, 'Gym')).toBeNull();
  });
});
