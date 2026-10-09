// Composes the Chrome Web Store images from the raw captures (capture.cjs):
// five 1280×800 screenshots with a headline, the two promo tiles and the
// 128×128 store icon. Rendered as HTML in headless Chromium, written as
// opaque PNGs (the store wants 24-bit PNG without alpha, or JPEG).
//
//   PLAYWRIGHT_CORE=… CHROMIUM=… [STORE_LANG=ko|en] node artifact/chrome-web-store/tools/compose.cjs
//
// Korean (default) goes to screenshots/ and promo/, English to
// screenshots/en/ and promo/en/; the icon has no words and is the same.

const fs = require('fs');
const path = require('path');
const { chromium } = require(process.env.PLAYWRIGHT_CORE || 'playwright-core');

const HERE = path.resolve(__dirname, '..');
const LANG = process.env.STORE_LANG === 'en' ? 'en' : 'ko';
const RAW = path.join(__dirname, 'raw', LANG);
const OUT = (dir) => (LANG === 'ko' ? path.join(HERE, dir) : path.join(HERE, dir, LANG));
const ICON = path.resolve(HERE, '../../src/icons/icon-256.png');
const dataUrl = (file) => `data:image/png;base64,${fs.readFileSync(file).toString('base64')}`;

const SCREENS_KO = [
  {
    raw: '1-paper', out: '01-paper-info',
    tag: '논문 정보',
    title: '논문을 열면 게재처와 인용 추이가 바로',
    sub: 'DOI·arXiv·제목을 알아보고 학회·저널, 연도, 인용 수와 연도별 그래프, BibTeX·APA 복사를 한 줄에 보여줍니다.',
  },
  {
    raw: '2-references', out: '02-references',
    tag: '참고문헌',
    title: '이 논문이 인용한 연구를, 인용 많은 순으로',
    sub: '참고문헌 목록을 훑고 바로 열어 보세요. 데이터베이스에 없으면 PDF에 인쇄된 목록을 직접 읽습니다.',
  },
  {
    raw: '3-annotate', out: '03-annotate-sync',
    tag: '필기 · 동기화',
    title: '형광펜·펜·메모, 어느 기기에서 열어도 그대로',
    sub: '필기와 읽던 페이지를 내 Google Drive의 앱 전용 공간으로 동기화합니다. PDF 파일은 올리지 않습니다.',
  },
  {
    raw: '4-projects', out: '04-projects',
    tag: '프로젝트',
    title: '논문은 흩어지지 않게, 프로젝트별 탭 하나에',
    sub: '웹에서 연 PDF가 한 탭에 모입니다. 프로젝트·폴더로 정리하고 아이콘으로 구분하며, 논문 종류도 아이콘으로 보입니다.',
  },
  {
    raw: '5-figures', out: '05-figure-capture',
    tag: '그림 캡처',
    title: '그림·표를 자동으로 찾아 클릭 한 번에 복사',
    sub: 'S 키를 누르면 페이지의 그림과 표가 표시되고, 누르면 출처와 함께 이미지로 복사됩니다.',
  },
];

const SCREENS_EN = [
  {
    raw: '1-paper', out: '01-paper-info',
    tag: 'Paper info',
    title: 'Open a paper, see its venue and citations at once',
    sub: 'Recognizes the DOI, arXiv ID or title, then shows the conference or journal, year, citation count with a yearly chart, and one-click BibTeX and APA in a single line.',
  },
  {
    raw: '2-references', out: '02-references',
    tag: 'References',
    title: 'Everything it cites, most-cited first',
    sub: 'Skim the reference list and open any entry. When no database has it, the list printed in the PDF is read directly.',
  },
  {
    raw: '3-annotate', out: '03-annotate-sync',
    tag: 'Annotate · Sync',
    title: 'Highlights, pen and notes, the same on every device',
    sub: 'Your drawings and reading position sync through an app-only space in your own Google Drive. PDF files are never uploaded.',
  },
  {
    raw: '4-projects', out: '04-projects',
    tag: 'Projects',
    title: 'One tab per project, so papers never scatter',
    sub: 'PDFs you open on the web gather in one tab. Sort them into projects and folders, tell projects apart by icon, and see each paper’s kind at a glance.',
  },
  {
    raw: '5-figures', out: '05-figure-capture',
    tag: 'Figure capture',
    title: 'Find figures and tables, copy one with a click',
    sub: 'Press S to outline every figure and table on the page; click one to copy it as an image, with its source.',
  },
];

const TEXT = {
  ko: {
    screens: SCREENS_KO,
    tile: '논문 읽기를 위한 PDF 뷰어<br>필기는 내 Google Drive로 동기화',
    marquee: '논문 PDF를 위한 Chrome 뷰어.<br>읽던 곳과 필기가 모든 기기를 따라옵니다.',
    chips: ['게재처·인용 추이', '참고문헌', '형광펜·필기 동기화', '프로젝트별 탭', '그림·표 캡처'],
  },
  en: {
    screens: SCREENS_EN,
    tile: 'A PDF viewer for reading papers<br>Notes sync to your Google Drive',
    marquee: 'A Chrome PDF viewer for research papers.<br>Your place and notes follow you everywhere.',
    chips: ['Venue & citation trend', 'References', 'Highlights that sync', 'A tab per project', 'Figure & table capture'],
  },
}[LANG];

const FONT = `'Pretendard', 'Noto Sans KR', 'Noto Sans CJK KR', 'Apple SD Gothic Neo', system-ui, sans-serif`;
const BASE_CSS = `
  @import url('https://fonts.googleapis.com/css2?family=Noto+Sans+KR:wght@400;500;700;800&display=swap');
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body { width: 100%; height: 100%; }
  body {
    font-family: ${FONT};
    color: #f3f6fc;
    background: radial-gradient(1200px 600px at 85% -10%, #2b4c8c 0%, transparent 60%),
                radial-gradient(900px 500px at -10% 110%, #3b2a6b 0%, transparent 55%),
                #0d1526;
    overflow: hidden;
    -webkit-font-smoothing: antialiased;
  }
`;

function screenHtml(screen) {
  return `<!doctype html><html lang="${LANG}"><head><meta charset="utf-8"><style>${BASE_CSS}
    .head { position: absolute; left: 72px; right: 72px; top: 44px; }
    .tag { display: inline-flex; align-items: center; gap: 8px; height: 28px; padding: 0 12px; border-radius: 14px;
      background: rgba(138, 180, 248, 0.16); color: #a9c7ff; font-size: 14px; font-weight: 700; letter-spacing: 0.02em; }
    .tag img { width: 18px; height: 18px; border-radius: 5px; }
    h1 { margin-top: 14px; font-size: 38px; font-weight: 800; letter-spacing: -0.02em; line-height: 1.2; }
    p { margin-top: 10px; max-width: 1040px; color: #b8c3d9; font-size: 18px; line-height: 1.55; }
    .shot { position: absolute; left: 50%; top: 232px; width: 1136px; transform: translateX(-50%);
      border-radius: 14px; overflow: hidden; box-shadow: 0 30px 80px rgba(0, 0, 0, 0.55), 0 0 0 1px rgba(255, 255, 255, 0.08); }
    .shot img { display: block; width: 100%; }
  </style></head><body>
    <div class="head">
      <span class="tag"><img src="${dataUrl(ICON)}">${screen.tag}</span>
      <h1>${screen.title}</h1>
      <p>${screen.sub}</p>
    </div>
    <div class="shot"><img src="${dataUrl(path.join(RAW, `${screen.raw}.png`))}"></div>
  </body></html>`;
}

function smallTileHtml() {
  return `<!doctype html><html lang="${LANG}"><head><meta charset="utf-8"><style>${BASE_CSS}
    body { display: flex; flex-direction: column; justify-content: center; padding: 0 36px; }
    .row { display: flex; align-items: center; gap: 16px; }
    img { width: 72px; height: 72px; border-radius: 18px; box-shadow: 0 10px 24px rgba(0,0,0,0.4); }
    h1 { font-size: 34px; font-weight: 800; letter-spacing: -0.02em; }
    p { margin-top: 18px; color: #c9d4ea; font-size: 19px; font-weight: 500; line-height: 1.45; }
  </style></head><body>
    <div class="row"><img src="${dataUrl(ICON)}"><h1>ResearchPDF</h1></div>
    <p>${TEXT.tile}</p>
  </body></html>`;
}

function marqueeHtml() {
  const { chips } = TEXT;
  return `<!doctype html><html lang="${LANG}"><head><meta charset="utf-8"><style>${BASE_CSS}
    .text { position: absolute; left: 80px; top: 0; bottom: 0; width: 560px; display: flex; flex-direction: column; justify-content: center; }
    .row { display: flex; align-items: center; gap: 18px; }
    .row img { width: 84px; height: 84px; border-radius: 20px; box-shadow: 0 12px 28px rgba(0,0,0,0.45); }
    h1 { font-size: 48px; font-weight: 800; letter-spacing: -0.02em; }
    p { margin-top: 22px; color: #c9d4ea; font-size: 24px; font-weight: 500; line-height: 1.5; }
    .chips { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 26px; }
    .chips span { padding: 7px 14px; border-radius: 18px; background: rgba(138,180,248,0.15); color: #b9d0ff; font-size: 16px; font-weight: 600; }
    .shot { position: absolute; left: 700px; top: 70px; width: 900px; border-radius: 16px; overflow: hidden;
      box-shadow: 0 30px 80px rgba(0,0,0,0.6), 0 0 0 1px rgba(255,255,255,0.08); }
    .shot img { display: block; width: 100%; }
  </style></head><body>
    <div class="text">
      <div class="row"><img src="${dataUrl(ICON)}"><h1>ResearchPDF</h1></div>
      <p>${TEXT.marquee}</p>
      <div class="chips">${chips.map((c) => `<span>${c}</span>`).join('')}</div>
    </div>
    <div class="shot"><img src="${dataUrl(path.join(RAW, '1-paper.png'))}"></div>
  </body></html>`;
}

function iconHtml() {
  // 128×128 with the artwork in the middle 96×96, as the store's icon guideline asks.
  return `<!doctype html><html><head><style>* { margin: 0; } html, body { background: transparent; }
    img { position: absolute; left: 16px; top: 16px; width: 96px; height: 96px; }</style></head>
    <body><img src="${dataUrl(ICON)}"></body></html>`;
}

(async () => {
  for (const dir of [OUT('screenshots'), OUT('promo'), path.join(HERE, 'icon')]) fs.mkdirSync(dir, { recursive: true });
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || undefined, headless: true });
  const render = async (html, width, height, file, { transparent = false } = {}) => {
    const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
    await page.setContent(html, { waitUntil: 'networkidle' }).catch(() => page.setContent(html));
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: file, omitBackground: transparent });
    await page.close();
    console.log('wrote', path.relative(HERE, file));
  };
  for (const screen of TEXT.screens) {
    if (!fs.existsSync(path.join(RAW, `${screen.raw}.png`))) { console.warn('missing raw', screen.raw); continue; }
    await render(screenHtml(screen), 1280, 800, path.join(OUT('screenshots'), `${screen.out}.png`));
  }
  await render(smallTileHtml(), 440, 280, path.join(OUT('promo'), 'small-tile-440x280.png'));
  await render(marqueeHtml(), 1400, 560, path.join(OUT('promo'), 'marquee-1400x560.png'));
  await render(iconHtml(), 128, 128, path.join(HERE, 'icon', 'store-icon-128.png'), { transparent: true });
  await browser.close();
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
