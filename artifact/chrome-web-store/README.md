# Chrome 웹 스토어 등록 자료

ResearchPDF(`obbepklelbbaaiomhjngdnkneffgmkog`)의 스토어 등록에 쓰는 문구와 이미지입니다.
여기 있는 것은 모두 공개해도 되는 자료입니다(대시보드 계정 정보, 테스트 계정, 키 없음).

| 파일 | 대시보드 위치 |
|---|---|
| [`listing.ko.md`](listing.ko.md) | 스토어 등록정보: 요약, 설명, 카테고리, 언어, 그래픽, URL |
| [`listing.en.md`](listing.en.md) | 영어 등록정보 (요약은 `_locales/en`) |
| [`privacy-practices.md`](privacy-practices.md) | 개인정보 보호: 단일 목적, 권한 사용 이유, 원격 코드, 데이터 사용 |
| `icon/store-icon-128.png` | 스토어 아이콘 |
| `screenshots/01…05-*.png` | 캡처화면 (1280×800, 순서대로) — 한국어 |
| `screenshots/en/01…05-*.png` | 같은 캡처화면 — 영어 (영어 등록정보용) |
| `promo/small-tile-440x280.png`, `promo/en/…` | 작은 프로모션 타일 (한국어, 영어) |
| `promo/marquee-1400x560.png`, `promo/en/…` | 마키 프로모션 타일 (한국어, 영어) |
| `tools/` | 위 이미지를 다시 만드는 스크립트 |

## 스크린샷 구성

| # | 파일 | 보여주는 기능 |
|---|---|---|
| 1 | `01-paper-info.png` | 논문 정보 줄: 게재처·연도·논문 종류, 인용 수와 연도별 그래프, BibTeX·APA |
| 2 | `02-references.png` | 참고문헌 목록(인용 많은 순) |
| 3 | `03-annotate-sync.png` | 형광펜·펜·텍스트 메모, Google Drive 동기화 |
| 4 | `04-projects.png` | 프로젝트별 허브 탭, 폴더·아이콘, 홈 화면의 논문 종류 아이콘 |
| 5 | `05-figure-capture.png` | 그림·표 자동 인식 캡처 |

## 이미지 다시 만들기

실제 확장 프로그램(`dist/`)을 헤드리스 Chromium에 올려 진짜 논문을 열고 찍습니다.
playwright-core와 Chromium이 필요합니다(`npx playwright install chromium`).

```bash
npm run build
PLAYWRIGHT_CORE=/path/to/node_modules/playwright-core CHROMIUM=/path/to/chrome STORE_LANG=ko node artifact/chrome-web-store/tools/capture.cjs
PLAYWRIGHT_CORE=/path/to/node_modules/playwright-core CHROMIUM=/path/to/chrome STORE_LANG=ko node artifact/chrome-web-store/tools/compose.cjs
# 영어: 같은 두 줄을 STORE_LANG=en으로
```

- 앱 아이콘의 정본은 Penpot `ResearchPDF` 파일 `component` 페이지의 `app-icon`(512px, 크림 바탕에 Fraunces 600 R, 노란 형광펜 띠)입니다. `docs/icon-512.png`는 그것을 그대로 내보낸 것이고, `src/icons/icon-{16…256}.png`는 그 512px를 `magick -filter Lanczos -resize`로 줄인 것입니다. 아이콘을 바꾸면 `compose.cjs`를 다시 돌려 스토어 아이콘과 타일에 반영합니다.
- `capture.cjs`는 원본 화면을 `tools/raw/<언어>/`(git 제외)에 저장합니다. 확장 프로그램 언어와 예시 프로젝트 이름(`LLM 추론` / `LLM reasoning` 등)을 `STORE_LANG`에 맞추고, 프로젝트·폴더·아이콘을 미리 만들어 두고 논문을 엽니다.
- `compose.cjs`는 원본 화면에 그 언어의 제목·설명을 얹어 1280×800 스크린샷, 프로모션 타일, 여백을 둔 스토어 아이콘을 만듭니다. 출력은 알파 없는 PNG입니다(아이콘만 투명 여백 때문에 RGBA).
- 논문 정보(게재처, 인용, 참고문헌)는 학술 DB에 묻지 않고 `tools/fixtures/papers.json`에 저장해 둔 응답으로 채웁니다. 그래서 OpenAlex 하루 한도나 Semantic Scholar 429와 상관없이 매번 같은 화면이 나옵니다. 저장된 응답이 없는 요청이 생기면 캡처가 실패합니다. 화면에 나오는 논문을 바꿨으면 `FIXTURES=record`로 한 번 찍습니다. 저장된 응답은 그대로 쓰고 없는 요청만 실제로 묻습니다(본인 OpenAlex 키가 있으면 `OPENALEX_API_KEY=…`, 기록할 때만 쓰고 저장하지 않음). 한도 초과나 서버 오류 응답은 기록하지 않고 실패로 알립니다. 처음부터 다시 기록하려면 파일을 지우고 찍습니다.

## 화면에 나오는 논문 (모두 CC BY 4.0)

스크린샷과 프로모션 타일에 나오는 논문은 모두 CC BY 4.0으로 공개된 것만 골랐습니다.

| 논문 | 저자 | 출처 |
|---|---|---|
| Chain-of-Thought Prompting Elicits Reasoning in Large Language Models | Wei et al., 2022 | [arXiv:2201.11903](https://arxiv.org/abs/2201.11903) |
| Tree of Thoughts: Deliberate Problem Solving with Large Language Models | Yao et al., 2023 | [arXiv:2305.10601](https://arxiv.org/abs/2305.10601) |
| ReAct: Synergizing Reasoning and Acting in Language Models | Yao et al., 2023 | [arXiv:2210.03629](https://arxiv.org/abs/2210.03629) |
| Direct Preference Optimization: Your Language Model is Secretly a Reward Model | Rafailov et al., 2023 | [arXiv:2305.18290](https://arxiv.org/abs/2305.18290) |
| Mistral 7B | Jiang et al., 2023 | [arXiv:2310.06825](https://arxiv.org/abs/2310.06825) |
| Good enough practices in scientific computing | Wilson et al., 2017 | [PLOS Comput Biol 13(6): e1005510](https://doi.org/10.1371/journal.pcbi.1005510) |

라이선스: <https://creativecommons.org/licenses/by/4.0/>. 화면에는 논문을 수정 없이 뷰어에 띄운 모습만 담았습니다.

## 등록 전 확인

- [ ] `capture.cjs`가 문제 없이 끝났는지 (⚠·저장 안 된 요청이 있으면 실패로 끝납니다), 한국어·영어 모두
- [ ] 패키지 요약이 등록정보와 맞는지 (`src/_locales/ko|en/messages.json`의 `appDescription`)
- [ ] 홈페이지(`docs/index.html`)에 프로젝트·그림 캡처 등 최신 기능이 반영됐는지
- [ ] 개인정보처리방침 URL이 열리는지
