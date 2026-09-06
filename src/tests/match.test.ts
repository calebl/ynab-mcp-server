import { describe, it, expect } from 'vitest';
import { rankMatches, resolveName, scoreMatch } from '../tools/match';

const accounts = [
  { id: 'a1', name: 'Ally Checking' },
  { id: 'a2', name: 'Ally Savings' },
  { id: 'a3', name: 'Apple Card' },
];

describe('scoreMatch', () => {
  it('scores an exact match highest, ignoring case and punctuation', () => {
    expect(scoreMatch('Apple Card', 'Apple Card')).toBe(1);
    expect(scoreMatch('apple card', 'Apple Card')).toBe(1);
    expect(scoreMatch('apple-card', 'Apple Card')).toBe(1);
  });

  it('ranks prefix above substring above word overlap', () => {
    const prefix = scoreMatch('ally', 'Ally Checking');
    const substring = scoreMatch('checking', 'Ally Checking');
    const overlap = scoreMatch('ally brokerage', 'Ally Checking');

    expect(prefix).toBeGreaterThan(substring);
    expect(substring).toBeGreaterThan(overlap);
    expect(overlap).toBeGreaterThan(0);
  });

  it('returns 0 when nothing lines up', () => {
    expect(scoreMatch('mortgage', 'Apple Card')).toBe(0);
    expect(scoreMatch('', 'Apple Card')).toBe(0);
  });
});

describe('rankMatches', () => {
  it('returns matches best first and drops non-matches', () => {
    const ranked = rankMatches('ally', accounts);

    expect(ranked.map((match) => match.item.name)).toEqual([
      'Ally Checking',
      'Ally Savings',
    ]);
    expect(ranked[0].score).toBeGreaterThan(0);
  });
});

describe('resolveName', () => {
  it('resolves an unambiguous name', () => {
    expect(resolveName('checking', accounts, 'account').id).toBe('a1');
    expect(resolveName('apple', accounts, 'account').id).toBe('a3');
  });

  it('throws and lists the options when nothing matches', () => {
    expect(() => resolveName('mortgage', accounts, 'account')).toThrow(
      /No account matching "mortgage".*Ally Checking/s
    );
  });

  it('throws rather than guessing between equally good matches', () => {
    expect(() => resolveName('ally', accounts, 'account')).toThrow(
      /ambiguous.*Ally Checking, Ally Savings/s
    );
  });

  it('truncates a long list of available names', () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ id: `id-${i}`, name: `Account ${i}` }));

    expect(() => resolveName('zzz', many, 'account')).toThrow(/\.\.\.$/);
  });
});
