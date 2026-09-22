import { debugError, debugLog, redactForDebugLog } from '../shared/debugLog';

export type BackgroundMessage = { type: string; [key: string]: unknown };
export type MessageHandler = (
  message: BackgroundMessage,
  sender: chrome.runtime.MessageSender,
) => unknown | Promise<unknown>;

/** True for the extension's own pages (popup, viewer), false for content scripts. */
export function isExtensionPageSender(sender: chrome.runtime.MessageSender): boolean {
  return sender.id === chrome.runtime.id
    && typeof sender.url === 'string'
    && sender.url.startsWith(chrome.runtime.getURL(''));
}

export function registerMessageDispatcher(handlers: Record<string, MessageHandler>): void {
  chrome.runtime.onMessage.addListener((message: BackgroundMessage, sender, sendResponse) => {
    // Only accept messages from our own extension (content scripts, popup, viewer).
    if (sender.id !== chrome.runtime.id) return false;

    const handler = message && handlers[message.type];
    if (!handler) return false;

    // Trace one message end-to-end at the dispatcher, not per handler. The full
    // message goes through redactForDebugLog because VOCAB_T_SET_CLOUD_SYNC_CONFIG
    // carries a WebDAV password; the thunk keeps this free when logging is off.
    const startedAt = performance.now();
    debugLog('bg:msg', `${message.type} received`, () => ({
      tabId: sender.tab?.id,
      url: sender.tab?.url,
      message: redactForDebugLog(message),
    }));
    Promise.resolve(handler(message, sender))
      .then((response) => {
        debugLog('bg:msg', `${message.type} responded (${Math.round(performance.now() - startedAt)}ms)`,
          () => redactForDebugLog(response));
        sendResponse(response);
      })
      .catch((err) => {
        // A handler crash must not leave the message port hanging.
        debugError('bg:msg', `${message.type} rejected (${Math.round(performance.now() - startedAt)}ms)`,
          () => ({ error: err instanceof Error ? err.message : String(err) }));
        sendResponse({ success: false, error: err instanceof Error ? err.message : String(err) });
      });
    return true; // async response
  });
}
