import { ClosedDaysCache } from './closed-days-cache';

const state = (closedThrough: string) => ({
  closedThrough,
  timeZone: 'UTC',
});

describe('ClosedDaysCache', () => {
  it('returns what was set, and nothing for a user never seen', () => {
    const cache = new ClosedDaysCache(2);
    cache.set('a', state('2026-09-29'));

    expect(cache.get('a')).toEqual(state('2026-09-29'));
    expect(cache.get('b')).toBeUndefined();
  });

  it('replaces a user’s entry without growing', () => {
    const cache = new ClosedDaysCache(2);
    cache.set('a', state('2026-09-28'));
    cache.set('a', state('2026-09-29'));

    expect(cache.get('a')).toEqual(state('2026-09-29'));
    expect(cache.size).toBe(1);
  });

  it('holds at most its cap, dropping the least recently set', () => {
    const cache = new ClosedDaysCache(2);
    cache.set('a', state('2026-09-29'));
    cache.set('b', state('2026-09-29'));
    cache.set('c', state('2026-09-29'));

    expect(cache.size).toBe(2);
    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('b')).toBeDefined();
    expect(cache.get('c')).toBeDefined();
  });

  it('keeps a user read since over one set before them', () => {
    const cache = new ClosedDaysCache(2);
    cache.set('a', state('2026-09-29'));
    cache.set('b', state('2026-09-29'));
    cache.get('a');
    cache.set('c', state('2026-09-29'));

    expect(cache.get('a')).toBeDefined();
    expect(cache.get('b')).toBeUndefined();
  });

  it('forgets a user deleted', () => {
    const cache = new ClosedDaysCache(2);
    cache.set('a', state('2026-09-29'));
    cache.delete('a');

    expect(cache.get('a')).toBeUndefined();
    expect(cache.size).toBe(0);
  });
});
