import { describe, expect, it } from 'vitest';
import { gatherLanded, isHubMessage, openedSinceUrls, parseGatherResult } from '../src/ui/pageKit';
import type { PdfLibrary, PdfLibraryEntry } from '../src/shared/pdfLibrary';
import { GATHER_RESULT_MESSAGE, SETTINGS_SHOWN_MESSAGE } from '../src/ui/openPdfTabs';
import { WELCOME_RESUME_MAX_AGE_MS, parseWelcomeResume, welcomeResumeStep } from '../src/shared/welcomeResume';

function entry(docId: string, urls: string[], openedAt: number): PdfLibraryEntry {
  return {
    docId, urls, fileName: null, docTitle: null, title: null, venue: null, year: null, numPages: 3, openedAt,
    pinned: false, pinChangedAt: 0, paperKind: null, userKind: null, userKindAt: 0,
  };
}

describe('closing a gathered tab only once its PDF is in a PDF tab', () => {
  const library: PdfLibrary = {
    a: entry('a', ['https://example.org/a.pdf', 'https://mirror.org/a.pdf'], 2_000),
    b: entry('b', ['https://example.org/b.pdf'], 500),
  };

  it('collects the URLs of rows opened since the gather began', () => {
    expect([...openedSinceUrls(library, 1_000)].sort()).toEqual(['https://example.org/a.pdf', 'https://mirror.org/a.pdf']);
    expect(openedSinceUrls(library, 3_000).size).toBe(0);
  });

  it('lands when a viewer opened it, or a PDF tab lists it and its bytes are cached', () => {
    const none = new Set<string>();
    const opened = new Set(['https://example.org/a.pdf']);
    const listed = new Set(['https://example.org/b.pdf']);
    // The fragment (zoom) of the source tab does not matter.
    expect(gatherLanded('https://example.org/a.pdf#zoom=125', { hubDocs: none, openedSince: opened, cached: none })).toBe(true);
    expect(gatherLanded('https://example.org/b.pdf', { hubDocs: listed, openedSince: none, cached: listed })).toBe(true);
    // Listed but not loaded or downloaded yet; or cached from before but in no PDF tab.
    expect(gatherLanded('https://example.org/b.pdf', { hubDocs: listed, openedSince: none, cached: none })).toBe(false);
    expect(gatherLanded('https://example.org/b.pdf', { hubDocs: none, openedSince: none, cached: listed })).toBe(false);
    expect(gatherLanded('chrome://newtab/', { hubDocs: none, openedSince: none, cached: none })).toBe(false);
  });
});

describe('messages from the hub to its settings frame', () => {
  it('reads the gather result as counts, from numbers or lists', () => {
    expect(parseGatherResult({ type: GATHER_RESULT_MESSAGE, gathered: 3, kept: 1 }, GATHER_RESULT_MESSAGE)).toEqual({ gathered: 3, kept: 1 });
    expect(parseGatherResult({ type: GATHER_RESULT_MESSAGE, gathered: [{}, {}], kept: [] }, GATHER_RESULT_MESSAGE)).toEqual({ gathered: 2, kept: 0 });
    expect(parseGatherResult({ tag: GATHER_RESULT_MESSAGE, gathered: -1, kept: 'x' }, GATHER_RESULT_MESSAGE)).toEqual({ gathered: 0, kept: 0 });
    expect(parseGatherResult({ type: 'other', gathered: 1 }, GATHER_RESULT_MESSAGE)).toBeNull();
    expect(parseGatherResult(null, GATHER_RESULT_MESSAGE)).toBeNull();
  });

  it('recognises "settings shown"', () => {
    expect(isHubMessage({ type: SETTINGS_SHOWN_MESSAGE }, SETTINGS_SHOWN_MESSAGE)).toBe(true);
    expect(isHubMessage({ tag: SETTINGS_SHOWN_MESSAGE }, SETTINGS_SHOWN_MESSAGE)).toBe(true);
    expect(isHubMessage({ type: GATHER_RESULT_MESSAGE }, SETTINGS_SHOWN_MESSAGE)).toBe(false);
    expect(isHubMessage('rpdf-settings-shown', SETTINGS_SHOWN_MESSAGE)).toBe(false);
  });
});

describe('resuming the welcome guide after an extension reload', () => {
  it('reopens at the recorded step while the marker is fresh', () => {
    expect(welcomeResumeStep({ step: 'open', at: 1_000 }, 1_000 + 60_000)).toBe('open');
    expect(welcomeResumeStep({ step: 'open', at: 1_000 }, 1_000 + WELCOME_RESUME_MAX_AGE_MS + 1)).toBeNull();
    expect(welcomeResumeStep({ step: 'open', at: 10_000_000 }, 1_000)).toBeNull();
    expect(welcomeResumeStep(undefined, 1_000)).toBeNull();
  });

  it('accepts only a plain step name', () => {
    expect(parseWelcomeResume({ step: 'gather', at: 5 })).toEqual({ step: 'gather', at: 5 });
    expect(parseWelcomeResume({ step: 'open#x', at: 5 })).toBeNull();
    expect(parseWelcomeResume({ step: 'open', at: Number.NaN })).toBeNull();
    expect(parseWelcomeResume('open')).toBeNull();
  });
});
