import { describe, expect, it } from 'vitest';

import { DEFAULT_DISPLAY_PREFS, parseDisplayPrefs, tabLabels } from '../src/shared/displayPrefs';

const cot = { docName: '2201.11903', paperTitle: 'Chain-of-Thought Prompting', venue: 'NeurIPS', year: 2022 };

describe('display preferences', () => {
  it('reads stored preferences, falling back per field', () => {
    expect(parseDisplayPrefs(undefined)).toEqual(DEFAULT_DISPLAY_PREFS);
    expect(parseDisplayPrefs({ tabTitle: 'document', kindIcons: 'neon', projectFavicon: false }))
      .toEqual({ ...DEFAULT_DISPLAY_PREFS, tabTitle: 'document', projectFavicon: false });
    expect(parseDisplayPrefs({ afterMove: 'follow' }).afterMove).toBe('follow');
    expect(parseDisplayPrefs({ afterMove: 'jump' }).afterMove).toBe('stay');
  });

  it('names a tab by the paper with its venue, by default', () => {
    expect(tabLabels(cot, DEFAULT_DISPLAY_PREFS)).toEqual({ title: 'Chain-of-Thought Prompting', subtitle: 'NeurIPS 2022' });
    expect(tabLabels(cot, { tabTitle: 'document', tabSubtitle: 'other' })).toEqual({ title: '2201.11903', subtitle: 'Chain-of-Thought Prompting' });
    // A name the user gave it comes first; the second line names the paper.
    expect(tabLabels({ ...cot, userTitle: 'CoT' }, { tabTitle: 'document', tabSubtitle: 'other' })).toEqual({ title: 'CoT', subtitle: 'Chain-of-Thought Prompting' });
    expect(tabLabels(cot, { tabTitle: 'paper', tabSubtitle: 'other' })).toEqual({ title: 'Chain-of-Thought Prompting', subtitle: '2201.11903' });
    expect(tabLabels(cot, { tabTitle: 'paper', tabSubtitle: 'none' }).subtitle).toBeNull();
  });

  it('falls back to the PDF name and never repeats the title', () => {
    expect(tabLabels({ docName: 'notes.pdf', paperTitle: null, venue: null, year: null }, DEFAULT_DISPLAY_PREFS)).toEqual({ title: 'notes.pdf', subtitle: null });
    expect(tabLabels({ docName: 'Deep Learning', paperTitle: 'Deep learning', venue: null, year: null }, { tabTitle: 'document', tabSubtitle: 'other' }).subtitle).toBeNull();
  });
});
