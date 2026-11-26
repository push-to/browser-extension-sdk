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
 * The call is made with a callback, and a promise it returns is used too:
 * Chrome's reference dates the promise form from Chrome 96, and the callback
 * form is older. Whichever answers first decides. Rejects when the call
 * throws, when its promise rejects, or when the callback is called with
 * `chrome.runtime.lastError` set.
 *
 * Nothing else is needed from the page. After a grant this also sends the
 * extension's service worker one message, `{ type: 'pushto:permission-granted' }`,
 * which the SDK there handles like `chrome.permissions.onAdded`: it registers
 * with the identity it was last given. A failure to send it is ignored.
 */
export function requestNotificationPermission(): Promise<boolean> {
  // The executor runs at once, so the request is made before this returns;
  // if the call throws, the promise is rejected with what it threw.
  return new Promise<unknown>((resolve, reject) => {
    // Typed here: no overload in @types/chrome takes a callback and returns
    // something to look at.
    const request = chrome.permissions.request as (
      query: { permissions: string[] },
      callback: (result: unknown) => void,
    ) => unknown;
    const returned = request.call(
      chrome.permissions,
      { permissions: ['notifications'] },
      (result) => {
        const error = chrome.runtime?.lastError;
        if (error) {
          reject(new Error(error.message ?? 'unknown error'));
        } else {
          resolve(result);
        }
      },
    );
    if (typeof (returned as { then?: unknown } | null)?.then === 'function') {
      (returned as PromiseLike<unknown>).then(resolve, reject);
    }
  }).then((result) => {
    const granted = result === true;
    if (granted) {
      tellServiceWorker();
    }
    return granted;
  });
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
