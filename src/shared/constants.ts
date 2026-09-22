// ─── ResearchPDF constants ───

export const DB_NAME = 'ResearchPDF';
export const DB_VERSION = 1;
export const STORE_SETTINGS = 'settings';
export const STORE_PDF_ANNOTATIONS = 'pdf_annotations';

// Viewer routing (see background/pdfRouting.ts).
export const LOCAL_PDF_VIEWER_ENABLED_SETTING_KEY = 'localPdfViewerEnabled';
export const DEFAULT_LOCAL_PDF_VIEWER_ENABLED = true;
export const WEB_PDF_VIEWER_ENABLED_SETTING_KEY = 'webPdfViewerEnabled';
export const DEFAULT_WEB_PDF_VIEWER_ENABLED = false;

// Paper strip (venue, citations, references) in the viewer.
export const PAPER_INFO_ENABLED_SETTING_KEY = 'paperInfoEnabled';
export const DEFAULT_PAPER_INFO_ENABLED = true;
// Optional user-supplied key; never synced or exported.
export const SEMANTIC_SCHOLAR_API_KEY_SETTING_KEY = 'semanticScholarApiKey';

// Google Drive sync. The OAuth client ID is public by design (it identifies
// the app, it is not a credential): tokens are only ever delivered to the
// redirect URIs registered on that client, and this build ships no client
// secret and stores no refresh token. GCP project `researchpdf-sync`, client
// "ResearchPDF extension" (web application). See docs/google-drive-sync.md.
export const GOOGLE_OAUTH_CLIENT_ID = '355378593067-61bfn1c2ov40qkjvkj1m9aoaolavq0vg.apps.googleusercontent.com';
// Least privilege: the app's own hidden Drive folder only. ResearchPDF can
// never list, read, or write any other file in the user's Drive with this scope.
export const GOOGLE_DRIVE_APPDATA_SCOPE = 'https://www.googleapis.com/auth/drive.appdata';
export const GOOGLE_DRIVE_SYNC_FILE_NAME = 'researchpdf-sync-v1.json';
