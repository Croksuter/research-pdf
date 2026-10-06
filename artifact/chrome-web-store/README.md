# Chrome 웹 스토어 등록 자료

ResearchPDF(`obbepklelbbaaiomhjngdnkneffgmkog`)의 스토어 등록에 쓰는 문구와 이미지입니다.
여기 있는 것은 모두 공개해도 되는 자료입니다(대시보드 계정 정보, 테스트 계정, 키 없음).

| 파일 | 대시보드 위치 |
|---|---|
| [`listing.ko.md`](listing.ko.md) | 스토어 등록정보: 요약, 설명, 카테고리, 언어, 그래픽, URL |
| [`listing.en.md`](listing.en.md) | 영어 등록정보 (요약은 `_locales/en`) |
| [`privacy-practices.md`](privacy-practices.md) | 개인정보 보호: 단일 목적, 권한 사용 이유, 원격 코드, 데이터 사용 |
| `icon/store-icon-128.png` | 스토어 아이콘 |
| `screenshots/01…05-*.png` | 캡처화면 (1280×800, 순서대로) |
| `promo/small-tile-440x280.png` | 작은 프로모션 타일 |
| `promo/marquee-1400x560.png` | 마키 프로모션 타일 |
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
PLAYWRIGHT_CORE=/path/to/node_modules/playwright-core CHROMIUM=/path/to/chrome node artifact/chrome-web-store/tools/capture.cjs
PLAYWRIGHT_CORE=/path/to/node_modules/playwright-core CHROMIUM=/path/to/chrome node artifact/chrome-web-store/tools/compose.cjs
```

- `capture.cjs`는 원본 화면을 `tools/raw/`(git 제외)에 저장합니다. 프로젝트·폴더·아이콘을 미리 만들어 두고 논문 8편을 엽니다.
- `compose.cjs`는 원본 화면에 제목·설명을 얹어 1280×800 스크린샷, 프로모션 타일, 여백을 둔 스토어 아이콘을 만듭니다. 출력은 알파 없는 PNG입니다(아이콘만 투명 여백 때문에 RGBA).
- 논문 정보는 OpenAlex·Semantic Scholar에서 실시간으로 가져옵니다. OpenAlex는 키 없이 쓰면 IP당 하루 한도가 있어(자정 UTC = 09:00 KST 초기화), 한도가 바닥나면 "최근 2년 인용"과 연도별 그래프 자리에 ⚠가 나옵니다. `capture.cjs`는 그런 화면을 찍으면 `⚠ in the paper strip`이라고 알려 줍니다. 한도가 풀린 뒤 다시 찍거나, 본인 키를 `OPENALEX_API_KEY=…`로 넘기면(임시 프로필에만 저장) 한도와 상관없이 찍힙니다.

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

- [ ] 스크린샷 1·3에 ⚠ 표시가 없는지 (OpenAlex 한도)
- [ ] 패키지 요약이 등록정보와 맞는지 (`src/_locales/ko|en/messages.json`의 `appDescription`)
- [ ] 홈페이지(`docs/index.html`)에 프로젝트·그림 캡처 등 최신 기능이 반영됐는지
- [ ] 개인정보처리방침 URL이 열리는지
