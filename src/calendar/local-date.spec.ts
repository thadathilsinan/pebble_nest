import {
  addDays,
  daysBetween,
  daysInMonth,
  localDateTime,
  nowIn,
  todayIn,
} from './local-date';

describe('local dates', () => {
  it('adds days across month and year ends', () => {
    expect(addDays('2026-09-30', 1)).toBe('2026-10-01');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(addDays('2028-03-01', -1)).toBe('2028-02-29');
  });

  it('counts days between dates', () => {
    expect(daysBetween('2026-09-24', '2026-09-24')).toBe(0);
    expect(daysBetween('2026-09-24', '2026-10-07')).toBe(13);
    expect(daysBetween('2026-10-07', '2026-09-24')).toBe(-13);
  });

  it('knows each month’s length', () => {
    expect(daysInMonth('2026-02-10')).toBe(28);
    expect(daysInMonth('2028-02-10')).toBe(29);
    expect(daysInMonth('2026-04-30')).toBe(30);
    expect(daysInMonth('2026-12-01')).toBe(31);
  });

  it('reads today in a time zone', () => {
    // 20:30 UTC is already the next day in Kolkata (+05:30).
    const now = new Date('2026-09-24T20:30:00Z');
    expect(todayIn('UTC', now)).toBe('2026-09-24');
    expect(todayIn('Asia/Kolkata', now)).toBe('2026-09-25');
    expect(todayIn('America/Los_Angeles', now)).toBe('2026-09-24');
  });

  it('reads the local date and minute of the day in a time zone', () => {
    const now = new Date('2026-09-24T20:30:00Z');
    expect(nowIn('UTC', now)).toEqual({ date: '2026-09-24', minute: 1230 });
    expect(nowIn('Asia/Kolkata', now)).toEqual({
      date: '2026-09-25',
      minute: 120,
    });
    // Midnight is minute 0 of the new day, not 24:00 of the old one.
    expect(nowIn('UTC', new Date('2026-09-24T00:00:00Z'))).toEqual({
      date: '2026-09-24',
      minute: 0,
    });
  });

  it('formats a date and minutes as a local date-time', () => {
    expect(localDateTime('2026-09-24', 0)).toBe('2026-09-24T00:00');
    expect(localDateTime('2026-09-24', 545)).toBe('2026-09-24T09:05');
    expect(localDateTime('2026-09-24', 1439)).toBe('2026-09-24T23:59');
  });
});
