import { afterEach, describe, expect, it } from 'vitest';

import { setLanguage } from '../src/shared/i18n';
import { S } from '../src/ui/pdfViewer/viewerParts.strings';

describe('viewer strings (en)', () => {
  afterEach(() => setLanguage('ko'));

  it('the conflict summary agrees in number', () => {
    setLanguage('en');
    expect(S.conflictSummary(1, 2)).toBe('This PDF file has 1 annotation that isn’t in the browser, and the browser has 2 annotations that aren’t in the file. Which would you like to keep?');
    expect(S.conflictSummary(3, 1)).toContain('3 annotations that aren’t in the browser, and the browser has 1 annotation that isn’t in the file');
  });
});
