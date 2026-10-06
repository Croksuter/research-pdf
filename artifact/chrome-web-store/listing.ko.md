# 스토어 등록정보 (한국어, 기본 언어)

Chrome 웹 스토어 개발자 대시보드 → **스토어 등록정보** 탭에 그대로 옮겨 넣는 값입니다.

## 제품 세부정보

| 항목 | 값 |
|---|---|
| 패키지 제목 | `ResearchPDF` (manifest `name`, 대시보드에서 수정 불가) |
| 패키지 요약 | manifest `description`에서 옵니다(최대 132자). 아래 "요약" 참고 |
| 카테고리 | **도구** (대안: 생산성 → 업무 흐름 및 계획) |
| 언어 | **한국어** |

### 요약 (manifest `description`, 132자 이내)

현재 패키지 값(영어, 125자):

```
PDF viewer for papers. Drawings and reading position follow you across Chrome profiles and devices via your own Google Drive.
```

한국어 요약(64자). 이제 `src/_locales/ko/messages.json`의 `appDescription`으로 들어가 있어, 다음 버전부터 한국어 Chrome에는 이 요약이 보입니다(영어는 `_locales/en`):

```
논문 PDF 뷰어. 게재처·인용·참고문헌을 바로 보여주고, 필기와 읽던 위치를 내 Google Drive로 모든 기기에 동기화합니다.
```

## 설명 (최대 16,000자)

아래 블록 전체를 붙여 넣습니다(약 1,900자). 스토어 설명은 일반 텍스트이므로 줄바꿈과 `•`만 씁니다.

```
ResearchPDF는 논문을 읽는 사람을 위한 Chrome PDF 뷰어입니다. 웹에서 연 PDF와 컴퓨터의 PDF를 한 탭에 모아 보여주고, 논문을 알아보면 게재처와 인용 정보를 바로 붙여 줍니다. 필기와 읽던 위치는 내 Google Drive를 통해 모든 Chrome 프로필과 기기를 따라옵니다.

■ 논문 정보를 한 줄에
• DOI·arXiv ID·제목으로 논문을 알아보고 학회/저널, 연도, 논문 종류(저널·학회·프리프린트·서베이)를 표시합니다.
• 전체 인용 수와 최근 2년 인용 수, 연도별 인용 그래프를 보여줍니다.
• 참고문헌을 인용 많은 순으로 펼쳐 보고 바로 열 수 있습니다. 데이터베이스에 목록이 없으면 PDF에 인쇄된 참고문헌을 직접 읽습니다.
• BibTeX·APA 인용을 한 번에 복사합니다.
• 데이터는 OpenAlex, Crossref, arXiv, Semantic Scholar에서 가져옵니다(선택: 개인 API 키 입력).

■ 필기와 읽던 위치가 따라옵니다
• 형광펜, 펜, 텍스트 메모를 PDF 위에 바로 남깁니다.
• 같은 논문은 파일 이름이나 경로가 달라도 내용으로 알아보고, 필기와 마지막 페이지·확대 상태를 되살립니다.
• Google 계정을 연결하면 내 Drive의 앱 전용 숨김 공간으로 동기화합니다. PDF 파일 자체는 올리지 않습니다.
• 같은 논문을 두 곳에 열어 두면 한쪽의 필기가 다른 쪽에 실시간으로 나타납니다.

■ 논문이 웹 탭 사이에 흩어지지 않게
• PDF는 프로젝트별 탭 하나에 모이고, 그 안의 탭 줄로 오갑니다(Alt+Shift+←/→, Alt+W로 닫기, Alt+Shift+T로 다시 열기).
• 프로젝트를 만들어 논문을 나누고, 폴더로 묶고, 끌어서 순서를 정합니다. 프로젝트마다 아이콘·이모지·색을 정하면 Chrome 탭 아이콘으로도 보입니다.
• 프로젝트 탭을 닫았다가 열면 열려 있던 논문이 그대로 돌아옵니다. 자주 보는 논문은 고정해 둡니다.
• 홈 화면에서 열었던 모든 PDF를 읽은 정도와 함께 찾아볼 수 있습니다.

■ 그림·표 캡처
• S 키를 누르면 원하는 영역을 끌어서 이미지로 복사합니다.
• 한 번 더 누르면 페이지의 그림과 표를 자동으로 찾아 표시하고, 누르면 출처 정보와 함께 복사됩니다. 인식은 확장 프로그램에 들어 있는 모델로 기기 안에서만 이뤄집니다.

■ 개인정보
• PDF는 브라우저 안에서만 읽습니다. 논문을 찾을 때는 DOI·arXiv ID·제목 같은 식별자만 학술 데이터베이스에 보냅니다.
• 동기화 데이터는 개발자 서버가 아니라 사용자 본인의 Google Drive(앱 전용 폴더)에만 저장됩니다. 광고, 분석 도구, 추적이 없습니다.
• 개인정보처리방침: https://research-pdf.croksuter.com/privacy.html

■ 시작하기
1. 웹의 PDF 링크를 열거나, 컴퓨터의 PDF를 Chrome 창에 끌어다 놓으세요.
2. 웹 PDF를 이 뷰어로 열려면 확장 아이콘 → 설정에서 "웹 PDF도 ResearchPDF로 열기"를 켜고 권한을 허용합니다.
3. 컴퓨터의 PDF는 설정에서 "컴퓨터의 PDF를 ResearchPDF로 열기"를 켜고, 확장 프로그램 세부정보에서 "파일 URL에 대한 액세스 허용"을 켜면 열립니다.
4. 기기 간 동기화는 확장 아이콘이나 설정에서 Google 계정을 연결하면 시작됩니다.

문의와 버그 제보: https://github.com/Croksuter/research-pdf/issues
```

## 그래픽 저작물

| 항목 | 규격 | 파일 |
|---|---|---|
| 스토어 아이콘 | 128×128 PNG (그림 96×96, 사방 16px 투명 여백) | `icon/store-icon-128.png` |
| 스크린샷 1 | 1280×800, 24비트 PNG | `screenshots/01-paper-info.png` |
| 스크린샷 2 | 〃 | `screenshots/02-references.png` |
| 스크린샷 3 | 〃 | `screenshots/03-annotate-sync.png` |
| 스크린샷 4 | 〃 | `screenshots/04-projects.png` |
| 스크린샷 5 | 〃 | `screenshots/05-figure-capture.png` |
| 작은 프로모션 타일 | 440×280, 24비트 PNG | `promo/small-tile-440x280.png` |
| 마키 프로모션 타일 | 1400×560, 24비트 PNG | `promo/marquee-1400x560.png` |
| 프로모션 동영상 | 선택 사항 | (없음) |

스크린샷은 위 순서대로 올립니다. 첫 장이 검색 결과와 상세 페이지 맨 앞에 보입니다.

## 추가 입력란

| 항목 | 값 |
|---|---|
| 공식 URL | `research-pdf.croksuter.com`을 Google Search Console에서 소유권 확인한 뒤 선택(선택 사항) |
| 홈페이지 URL | `https://research-pdf.croksuter.com/` (35자) |
| 지원 URL | `https://github.com/Croksuter/research-pdf/issues` (48자) |
| 성인용 콘텐츠 | **아니요** |
| Google 애널리틱스 4 | 사용 안 함 (확장 프로그램에 분석 도구가 없음) |
