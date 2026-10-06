# 개인정보 보호 탭 (Privacy practices)

대시보드 → **개인정보 보호** 탭의 답변입니다. 권한 설명은 리뷰어가 읽으므로
기능과 1:1로 대응하게 썼습니다. 근거가 되는 코드 위치를 함께 적었습니다.

## 단일 목적 (Single purpose)

```
학술 논문 PDF를 읽고 정리하기 위한 PDF 뷰어입니다. 웹과 컴퓨터의 PDF를 확장 프로그램 안의 PDF.js 뷰어로 열고, 논문을 알아보면 게재처·인용·참고문헌을 보여주며, 사용자가 원하면 필기와 읽던 위치를 사용자 본인의 Google Drive에 동기화합니다.
```

## 권한 사용 이유 (Permission justification)

| 권한 | 입력할 설명 | 코드 |
|---|---|---|
| `storage` | 설정, 열어 본 PDF 목록(라이브러리), 프로젝트, 문서별 읽던 위치를 이 기기에 저장합니다. | `src/background/*Store.ts` |
| `alarms` | Google Drive 동기화를 주기적으로 실행합니다. 계정을 연결하지 않았거나 동기화를 끈 경우 알람이 와도 아무것도 하지 않습니다. | `src/background.ts`, `src/background/pdfSyncService.ts` |
| `webNavigation` | 탭이 `.pdf` 주소나 로컬 PDF 파일로 이동하는 순간을 알아 내장 뷰어로 열고, 뷰어 탭이 다른 페이지로 이동했는지 확인합니다. 페이지 내용은 읽지 않습니다. | `src/background/pdfRouting.ts` |
| `declarativeNetRequestWithHostAccess` | PDF인 응답을 내장 뷰어로 보내는 리디렉션 규칙 6개를 둡니다. 최상위 문서는 PDF 탭으로(3개), 페이지에 끼워 넣은 PDF(iframe, embed/object)는 그 자리의 뷰어로(3개) 보내며, 각각 Content-Type이 PDF인 응답, 주소가 `.pdf`로 끝나는 `application/octet-stream` 응답, inline `.pdf` 파일 이름(Content-Disposition)인 응답에 적용됩니다. 다운로드(attachment)와 POST 응답은 제외합니다. 사용자가 웹 PDF 열기를 켜고 사이트 접근을 허용한 경우에만 설치되고, Chrome이 허용된 사이트에서만 적용합니다. | `src/shared/localPdf.ts` (`buildWebPdfRedirectRules`), `src/background/pdfRouting.ts` |
| `identity` | 사용자가 "Google 계정 연결"을 누를 때 OAuth 로그인 창을 띄워, Drive의 앱 전용 폴더(`drive.appdata` 범위)에만 접근하는 토큰을 받습니다. | `src/background/googleAuth.ts` |
| 호스트 권한 `file:///*` | 사용자가 로컬 PDF 열기를 켜고 Chrome에서 파일 URL 접근을 허용한 경우, 컴퓨터의 PDF 파일을 뷰어로 읽고, Chrome 기본 뷰어에 열린 로컬 PDF 탭을 찾아 PDF 탭으로 모으자고 제안합니다. | `src/ui/pdfViewer.ts`, `src/ui/openPdfTabs.ts` |
| 선택 호스트 권한 `https://*/*`, `http://*/*` | 설치 시 요청하지 않습니다. 사용자가 "웹 PDF도 ResearchPDF로 열기"를 켜거나 뷰어에서 웹 PDF 열기를 허용할 때만 요청합니다. 쓰는 곳: PDF 응답을 뷰어로 돌리는 위 규칙, 뷰어가 웹 PDF 파일을 내려받아 표시하고 기기에 보관하는 것, Chrome 기본 뷰어로 PDF를 보여 주는 탭의 주소·제목을 읽어 홈·설정·시작 가이드에서 PDF 탭으로 모으자고 제안하는 것(주소·제목은 기기 밖으로 나가지 않음). | `src/ui/settings.ts`, `src/ui/pdfViewer.ts`, `src/ui/pdfFileFetch.ts`, `src/ui/openPdfTabs.ts` |

### 원격 코드 (Remote code)

**아니요, 원격 코드를 사용하지 않습니다.**

```
실행되는 모든 코드(PDF.js, ONNX Runtime의 WebAssembly, 그림 인식 모델 포함)는 패키지 안에 들어 있습니다. 네트워크로 받는 것은 학술 데이터베이스(OpenAlex, Crossref, arXiv, Semantic Scholar)의 JSON/XML 응답, 사용자가 연 PDF 파일, 사용자의 Google Drive에 저장된 동기화 데이터뿐이며 어느 것도 코드로 실행하지 않습니다.
```

## 데이터 사용 (Data usage)

"현재 또는 향후에 사용자로부터 수집할 예정인 사용자 데이터" 체크 항목:

| 항목 | 체크 | 이유 |
|---|---|---|
| 개인 식별 정보 | ☑ | 연결한 Google 계정의 이메일 주소를 Drive API에서 받아, 어떤 계정이 연결됐는지 팝업과 설정 페이지에 보여줍니다. 기기에만 저장하며 개발자에게 보내지 않습니다. |
| 건강 정보 | ☐ | |
| 금융 및 결제 정보 | ☐ | |
| 인증 정보 | ☐ | 비밀번호를 다루지 않습니다. OAuth 토큰은 Google이 발급해 Drive 호출에만 쓰고 기기에만 둡니다. |
| 개인 커뮤니케이션 | ☐ | |
| 위치 | ☐ | |
| 웹 기록 | ☑ | 열어 본 PDF의 주소 목록(라이브러리)을 기기에 저장하고, 동기화를 켜면 사용자 본인의 Drive 앱 전용 폴더에 저장합니다. |
| 사용자 활동 | ☐ | 클릭·키 입력 등을 기록하거나 전송하지 않습니다. |
| 웹사이트 콘텐츠 | ☑ | PDF 안의 필기와 읽던 위치를 저장·동기화하고, 논문을 찾기 위해 DOI·arXiv ID·제목을 학술 데이터베이스에 보냅니다. |

인증 3개는 모두 체크합니다.

- ☑ 승인된 사용 사례를 제외하고 서드 파티에 사용자 데이터를 판매하거나 전송하지 않습니다.
- ☑ 항목의 단일 목적과 관련 없는 목적으로 사용자 데이터를 사용하거나 전송하지 않습니다.
- ☑ 신용도를 판단하거나 대출 목적으로 사용자 데이터를 사용하거나 전송하지 않습니다.

### 개인정보처리방침 URL

```
https://research-pdf.croksuter.com/privacy.html
```

(`docs/privacy.html`, GitHub Pages로 게시. 영어가 먼저, 한국어는 `#ko`: 한국어 등록정보에는 `https://research-pdf.croksuter.com/privacy.html#ko`)
