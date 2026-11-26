/**
 * Helpers for the extension's pages (popup, options page, side panel).
 * Nothing here needs a service worker, and nothing from the service-worker
 * part of the SDK is imported.
 */

/** The same string as `PERMISSION_GRANTED_MESSAGE` in the worker code. */
const PERMISSION_GRANTED_MESSAGE = 'pushto:permission-granted';

/**
 * Asks the user for the `notifications` permission, for an extension that
 * declares it in `optional_permissions`. Resolves to whether it was granted.
 *
 * Chrome only accepts the request inside a user gesture, so call this first
 * in the click handler, before any `await`: an earlier asynchronous call can
 * lose the gesture. The `chrome.permissions.request` call is made
 * synchronously, before this function returns.
 *
 * Nothing else is needed from the page. After a grant this also sends the
 * extension's service worker one message, `{ type: 'pushto:permission-granted' }`,
 * which the SDK there handles like `chrome.permissions.onAdded`: it registers
 * with the identity it was last given. A failure to send it is ignored.
 */
export function requestNotificationPermission(): Promise<boolean> {
  try {
    return Promise.resolve(
      chrome.permissions.request({ permissions: ['notifications'] }),
    ).then((result) => {
      const granted = result === true;
      if (granted) {
        tellServiceWorker();
      }
      return granted;
    });
  } catch (error) {
    return Promise.reject(error);
  }
}

function tellServiceWorker() {
  try {
    // Rejects when nothing listens (no SDK in the worker): not an error here.
    void Promise.resolve(
      chrome.runtime.sendMessage({ type: PERMISSION_GRANTED_MESSAGE }),
    ).catch(() => undefined);
  } catch {
    // no runtime to send to
  }
}
