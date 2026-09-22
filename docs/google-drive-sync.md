# Google Drive sync

Every Chrome profile and every computer that connects the same Google account
shares one set of drawings and reading positions. This document covers the
sign-in and the Drive transport; the sync document and merge are in
`docs/architecture.md`.

## What the user sees

Popup → Google Drive 동기화. "Google 계정 연결" opens
Google's account chooser. After consent the first sync runs immediately, then
about every 15 minutes (`researchpdf-sync`), at browser start, when a document
opens, and shortly after a drawing is stored. A sync
where neither side changed costs one metadata request and transfers nothing.
"연결 해제" revokes the token and forgets the account on this device; the Drive
file stays, because other profiles still sync with it.

## Security model

- **Scope:** `drive.appdata` only. ResearchPDF gets a hidden per-app folder and can
  never list, read, or write any other Drive file. The scope is non-sensitive in
  Google's classification, so no restricted-scope audit applies.
- **No secret, no refresh token.** The repository is public. The flow is OAuth
  implicit via `chrome.identity.launchWebAuthFlow`; the only embedded value is
  the OAuth client ID, which is public by design. Google delivers tokens solely
  to redirect URIs registered on the client, and the browser itself intercepts
  `https://<extension-id>.chromiumapp.org/`, so a token never crosses the network
  to anything but this extension.
- **Short-lived token, memory only.** Access tokens (~1 h) are cached in
  `chrome.storage.session`: never on disk, never readable by content scripts,
  gone when the browser closes. Renewal is silent (`prompt=none` +
  `login_hint`); if Google needs the user, sync fails with a "reconnect" message
  instead of opening UI from the background.
- **Response validation.** Each flow carries a fresh 192-bit `state`; the
  redirect must start with this extension's redirect URI, match the state (even
  to trust an error code), be a Bearer token, and include the scope. `tokeninfo`
  must then confirm `aud` equals our client ID. Tokens travel only in the
  `Authorization` header or a POST form body, never in a URL, and are never
  logged.
- **Account pinning.** The connected account is stored as Drive `permissionId`
  plus display email. Every silently renewed token is checked against that ID
  before use; a token for any other account is revoked and the sync refused, so
  one account's vocabulary can never be written into another's Drive.
- **Message boundary.** `VOCAB_T_CONNECT_GOOGLE_SYNC` and
  `VOCAB_T_DISCONNECT_GOOGLE_SYNC` are accepted from extension pages only (a
  content script shares the extension's sender id). `VOCAB_T_SET_CLOUD_SYNC_CONFIG`
  may carry `provider` but can never set the Google account.
- **Request pinning.** Every Drive request, including the server-supplied
  resumable-upload session URI, must start with the Drive API or upload base
  URL. File and revision IDs from responses are shape-checked before they are
  interpolated into a path. No Google host permission is declared: the endpoints
  are CORS-enabled, so the manifest gains only `identity`.
- **At rest in Drive:** gzip-compressed, unencrypted backup JSON, exactly the
  portable data set. `genaiApiKey`, the Semantic Scholar key, WebDAV
  credentials, and sync state never leave the device.

## Version safety without `If-Match`

Drive v3 has no conditional write, so `src/background/googleDriveStore.ts`
emulates one with `headRevisionId`. The version token is `fileId:revisionId`.

1. **Read** lists the file, downloads the body, then re-reads the head revision.
   The body is attributed to a revision only if the head did not move meanwhile.
2. **Update** re-reads the head first and reports a precondition failure (the
   `412` equivalent, one re-fetch/retry) if it is not the merged-against revision.
3. **After the upload** it reads the revision chain. If another writer's revision
   sits between the merged-against revision and ours, that revision was replaced
   unseen. It is reported as `clobbered`, persisted as `cloudSyncState.repair`
   *before* anything else, and the run does not apply locally. The next attempt
   (up to two more in the same run, otherwise the next sync) folds the lost
   revision's body into the remote operand and uploads again.
4. **The fold is additive (base-less) on purpose.** A linear revision chain
   cannot prove what the lost writer merged against; a wrong ancestor would turn
   its rows into deletions. An additive fold can only resurrect a row deleted in
   that window, never drop one.
5. **Creation race:** the deterministic winner is the oldest file (then smallest
   id). A loser deletes its own file, which holds nothing its local database
   does not, and retries against the winner.
6. **A merge base belongs to one remote object.** If the file ID differs from
   the stored token's, the merge runs base-less instead of reading every row the
   new object lacks as a deletion. Connecting a different account resets the
   base the same way a WebDAV target change does.

Residual risk, accepted and documented: if the service worker dies in the few
milliseconds between a clobbering upload completing and the `repair` record
being written, the lost revision is not folded back automatically. It remains in
Drive's revision history.

## One-time Google Cloud setup (maintainer)

Only the project owner does this, once. End users never see it.

1. `gcloud projects create <id>` and `gcloud services enable drive.googleapis.com`.
2. Google Auth Platform → Branding: app name, support email. Audience: External,
   then **Publish to production**. With only the non-sensitive `drive.appdata`
   scope no verification review is required, and consent does not expire weekly
   the way it does in Testing mode. Data access: add `drive.appdata`.
3. Clients → Create client → **Web application**. Authorized redirect URI:
   `https://<extension-id>.chromiumapp.org/` (the popup prints the exact value).
   No JavaScript origins. Do not download or commit the client secret; the
   implicit flow never uses it.
4. Put the client ID in `GOOGLE_OAUTH_CLIENT_ID` (`src/shared/constants.ts`).

Done for this project: GCP project `researchpdf-sync`, consent screen
"ResearchPDF" (external, published), scope `drive.appdata`, client
"ResearchPDF extension".

Steps 2 and 3 have no public API or `gcloud` command for a general-purpose
OAuth client; they are Console-only.

### Extension ID

The redirect URI embeds the extension ID. An unpacked extension's ID is derived
from its absolute path, so each distinct install path is a distinct ID and needs
its own redirect URI on the client (a client accepts many). Pinning a `key` in
`manifest.json` gives one stable ID everywhere, **but changing the ID orphans the
existing IndexedDB data of an already-loaded copy**: export a backup first, and
import it after the reload. A Web Store release has its own fixed ID; add its
redirect URI too.
