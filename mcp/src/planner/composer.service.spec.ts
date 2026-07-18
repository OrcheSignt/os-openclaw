import { ComposerService } from './composer.service.js';
import type { Citation } from './composer.types.js';

const CITATIONS: Citation[] = [
  { id: 'c1', itemId: 'item-1', chunkId: 'chunk-1', searchId: 'search-1' },
  { id: 'c2', itemId: 'item-2', auditId: 'audit-9' },
];

describe('ComposerService', () => {
  let composer: ComposerService;

  beforeEach(() => {
    composer = new ComposerService();
  });

  describe('verifyDraft', () => {
    it('passes a draft whose markers all resolve', () => {
      const draft =
        '# Findings\n' +
        '[Alice emailed Bob about the Q3 wire on March 4](cite:c1). ' +
        '[The transfer was flagged by compliance](cite:c2).';
      const result = composer.verifyDraft(draft, CITATIONS);
      expect(result.valid).toBe(true);
      expect(result.unresolvedMarkers).toEqual([]);
      expect(result.unmarkedSentences).toEqual([]);
    });

    it('catches a fabricated citation id', () => {
      const draft =
        '[Alice emailed Bob about the Q3 wire](cite:c1). ' +
        '[Bob then wired the funds offshore](cite:c99).';
      const result = composer.verifyDraft(draft, CITATIONS);
      expect(result.valid).toBe(false);
      expect(result.unresolvedMarkers).toEqual([
        { markerId: 'c99', claimText: 'Bob then wired the funds offshore' },
      ]);
    });

    it('flags long declarative sentences with no marker', () => {
      const draft =
        '[Alice emailed Bob](cite:c1). ' +
        'The wire transfer was clearly intended to conceal the source of the funds.';
      const result = composer.verifyDraft(draft, CITATIONS);
      expect(result.valid).toBe(false);
      expect(result.unmarkedSentences).toEqual([
        'The wire transfer was clearly intended to conceal the source of the funds.',
      ]);
    });

    it('is conservative: skips headings, questions, and short sentences', () => {
      const draft =
        '# Summary of communications between custodians in this matter\n' +
        'Should we escalate this finding to outside counsel for privilege review?\n' +
        'See below.\n' +
        '[Alice emailed Bob about the wire](cite:c1).';
      const result = composer.verifyDraft(draft, CITATIONS);
      expect(result.valid).toBe(true);
    });
  });

  describe('compose', () => {
    it('returns a citation map and zero retries when the first draft is valid', async () => {
      const draft = '[Alice emailed Bob about the Q3 wire transfer](cite:c1).';
      const draftFn = jest.fn().mockResolvedValue(draft);

      const result = await composer.compose(draftFn, CITATIONS);

      expect(draftFn).toHaveBeenCalledTimes(1);
      expect(draftFn).toHaveBeenCalledWith();
      expect(result.text).toBe(draft);
      expect(result.retries).toBe(0);
      expect(result.removedClaims).toEqual([]);
      expect(result.citationMap).toEqual({ c1: CITATIONS[0] });
    });

    it('re-asks with structured feedback naming the fabricated id, then succeeds', async () => {
      const bad = '[Bob wired the funds to an offshore account](cite:c99).';
      const good = '[Bob wired the funds to an offshore account](cite:c2).';
      const draftFn = jest
        .fn()
        .mockResolvedValueOnce(bad)
        .mockResolvedValueOnce(good);

      const result = await composer.compose(draftFn, CITATIONS);

      expect(draftFn).toHaveBeenCalledTimes(2);
      const feedback = draftFn.mock.calls[1][0] as string;
      expect(feedback).toContain('c99');
      expect(feedback).toContain('Bob wired the funds to an offshore account');
      expect(feedback).toContain('Valid citation ids: c1, c2');
      expect(result.retries).toBe(1);
      expect(result.text).toBe(good);
      expect(result.removedClaims).toEqual([]);
      expect(result.citationMap).toEqual({ c2: CITATIONS[1] });
    });

    it('strips the offending claim after retries are exhausted', async () => {
      const stubborn =
        '[Alice emailed Bob about the Q3 wire](cite:c1). ' +
        '[Bob fled the country the next morning](cite:c404).';
      const draftFn = jest.fn().mockResolvedValue(stubborn);

      const result = await composer.compose(draftFn, CITATIONS, 2);

      // initial draft + 2 bounded re-asks
      expect(draftFn).toHaveBeenCalledTimes(3);
      expect(result.retries).toBe(2);
      expect(result.removedClaims).toEqual([
        'Bob fled the country the next morning.',
      ]);
      expect(result.text).toBe(
        '[Alice emailed Bob about the Q3 wire](cite:c1).',
      );
      expect(result.citationMap).toEqual({ c1: CITATIONS[0] });
      expect(result.text).not.toContain('c404');
    });

    it('also strips uncited declarative sentences on exhaustion', async () => {
      const stubborn =
        '[Alice emailed Bob](cite:c1). ' +
        'It is obvious that the entire scheme was orchestrated by Bob himself.';
      const draftFn = jest.fn().mockResolvedValue(stubborn);

      const result = await composer.compose(draftFn, CITATIONS, 1);

      expect(draftFn).toHaveBeenCalledTimes(2);
      expect(result.retries).toBe(1);
      expect(result.removedClaims).toEqual([
        'It is obvious that the entire scheme was orchestrated by Bob himself.',
      ]);
      expect(result.text).toBe('[Alice emailed Bob](cite:c1).');
    });
  });
});
