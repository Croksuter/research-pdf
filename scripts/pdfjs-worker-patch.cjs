// ─── PDF.js worker patch: per-character positions in text content ───
//
// The worker already walks every glyph of a text run with its exact advance
// (kerning, word spacing, TJ gaps) to build `getTextContent` items, but only
// the run's total width leaves it. This patch records where each piece of the
// run's string starts and adds `charStarts` to horizontal, left-to-right,
// unnormalized items: one offset per UTF-16 code unit plus the run's end, in
// the same units as `width`. The viewer lays the selectable text out on those
// offsets (src/ui/pdfViewer/textLayerFonts.ts), so a selection boundary falls
// exactly between two rendered glyphs.
//
// Applied to pdfjs-dist's readable worker when rspack copies it. Every anchor
// must match exactly once: after a PDF.js upgrade that moved them, the build
// fails instead of shipping text without positions.

const PATCHES = [
  {
    name: 'item state',
    find: '    const textContentItem = {\n      initialized: false,\n      str: [],\n',
    replace: '    const textContentItem = {\n      initialized: false,\n      str: [],\n      rpdfStarts: [],\n',
  },
  {
    name: 'position helper',
    find: '    const TRACKING_SPACE_FACTOR = 0.102;\n',
    replace: [
      '    function rpdfPosition() {',
      '      return textContentItem.totalWidth + textContentItem.width * textContentItem.textAdvanceScale;',
      '    }',
      '    function rpdfCharStarts(chunk, text, bidiResult) {',
      '      if (chunk.vertical || bidiResult.str !== text || chunk.rpdfStarts.length !== chunk.str.length || chunk.str.join("") !== text) {',
      '        return null;',
      '      }',
      '      const end = chunk.totalWidth;',
      '      if (!(end > 0)) {',
      '        return null;',
      '      }',
      '      const out = [];',
      '      for (let k = 0; k < chunk.str.length; k++) {',
      '        const piece = chunk.str[k];',
      '        const from = chunk.rpdfStarts[k];',
      '        const to = k + 1 < chunk.str.length ? chunk.rpdfStarts[k + 1] : end;',
      '        for (let j = 0; j < piece.length; j++) {',
      '          out.push(Math.round((from + (to - from) * j / piece.length) * 1000) / 1000);',
      '        }',
      '      }',
      '      out.push(Math.round(end * 1000) / 1000);',
      '      return out;',
      '    }',
      '    const TRACKING_SPACE_FACTOR = 0.102;',
      '',
    ].join('\n'),
  },
  {
    name: 'glyph start',
    find: '        const textChunk = ensureTextContentItem();\n        if (category.isZeroWidthDiacritic) {\n',
    replace: '        const textChunk = ensureTextContentItem();\n        const rpdfStart = rpdfPosition();\n        if (category.isZeroWidthDiacritic) {\n',
  },
  {
    name: 'space before glyph',
    find: '        if (saveLastChar(glyphUnicode)) {\n          textChunk.str.push(" ");\n',
    replace: '        if (saveLastChar(glyphUnicode)) {\n          textChunk.rpdfStarts.push(rpdfStart);\n          textChunk.str.push(" ");\n',
  },
  {
    name: 'glyph',
    find: '        if (!intersector) {\n          textChunk.str.push(glyphUnicode);\n',
    replace: '        if (!intersector) {\n          textChunk.rpdfStarts.push(rpdfStart);\n          textChunk.str.push(glyphUnicode);\n',
  },
  {
    name: 'fake space',
    find: '        if (textContentItem.initialized) {\n          resetLastChars();\n          textContentItem.str.push(" ");\n',
    replace: '        if (textContentItem.initialized) {\n          resetLastChars();\n          textContentItem.rpdfStarts.push(rpdfPosition());\n          textContentItem.str.push(" ");\n',
  },
  {
    name: 'reset',
    find: '      textContentItem.initialized = false;\n      textContentItem.str.length = 0;\n',
    replace: '      textContentItem.initialized = false;\n      textContentItem.str.length = 0;\n      textContentItem.rpdfStarts.length = 0;\n',
  },
  {
    name: 'emit',
    find: '        fontName: textChunk.fontName,\n        hasEOL: textChunk.hasEOL\n      };\n',
    replace: '        fontName: textChunk.fontName,\n        hasEOL: textChunk.hasEOL,\n        charStarts: rpdfCharStarts(textChunk, text, bidiResult)\n      };\n',
  },
];

function patchPdfWorker(source) {
  let out = String(source);
  for (const patch of PATCHES) {
    const count = out.split(patch.find).length - 1;
    if (count !== 1) {
      throw new Error(`pdf.worker patch "${patch.name}": anchor found ${count} times (expected 1). Re-check scripts/pdfjs-worker-patch.cjs against this PDF.js version.`);
    }
    out = out.replace(patch.find, () => patch.replace);
  }
  return out;
}

module.exports = { patchPdfWorker, PATCHES };
