/**
 * The `notifications` permission may be optional (`optional_permissions`),
 * so the SDK must work, as far as it can, while the extension does not hold
 * it. What Chrome does then is only partly documented, so nothing here
 * assumes more than it checks:
 *
 * - `chrome.notifications` is looked for every time it is used. It is
 *   expected to be `undefined` before the grant; whether it appears in a
 *   worker that is already running when the permission is granted is not
 *   documented, so listeners are attached wherever the API is first seen.
 * - Whether the permission is held is asked of `chrome.permissions.contains`
 *   when that exists, and read from the presence of the API otherwise.
 */

const NOTIFICATIONS = 'notifications';

/**
 * Sent by `requestNotificationPermission()` (src/page.ts, which repeats the
 * string so as not to import this file) after a grant. Chrome does not
 * document that `permissions.onAdded` is delivered to the service worker;
 * this message is the second way the worker learns of the grant.
 */
export const PERMISSION_GRANTED_MESSAGE = 'pushto:permission-granted';

/** True when `chrome.notifications` can be called right now. */
export function hasNotificationsApi(): boolean {
  return typeof chrome !== 'undefined' && !!chrome.notifications;
}

export async function hasNotificationsPermission(): Promise<boolean> {
  try {
    // Typed here: the promise form is not in every @types/chrome.
    const permissions = chrome.permissions as
      | { contains?: (query: { permissions: string[] }) => Promise<boolean> }
      | undefined;
    if (typeof permissions?.contains === 'function') {
      return (
        (await permissions.contains({ permissions: [NOTIFICATIONS] })) === true
      );
    }
  } catch {
    // answered below
  }
  return hasNotificationsApi();
}

interface PermissionHandlers {
  /** `notifications` was granted. */
  added: () => void;
  /** `notifications` was removed. */
  removed: () => void;
}

/**
 * The SDK's `chrome.permissions.onAdded` / `onRemoved` listeners. Added once
 * per worker, at top-level startup like every other listener; re-initialising
 * the SDK only swaps what they call.
 */
export class PermissionWatcher {
  private static instance?: PermissionWatcher;

  private constructor(private handlers: PermissionHandlers) {}

  public static initialize(handlers: PermissionHandlers) {
    if (this.instance) {
      this.instance.handlers = handlers;
      return;
    }
    const watcher = new PermissionWatcher(handlers);
    this.instance = watcher;

    const names = (permissions: chrome.permissions.Permissions | undefined) =>
      (permissions?.permissions ?? []) as string[];
    // `chrome.permissions` needs no permission of its own; the optional
    // chaining is for a runtime that lacks it all the same.
    chrome.permissions?.onAdded?.addListener((permissions) => {
      if (names(permissions).includes(NOTIFICATIONS)) {
        watcher.handlers.added();
      }
    });
    chrome.permissions?.onRemoved?.addListener((permissions) => {
      if (names(permissions).includes(NOTIFICATIONS)) {
        watcher.handlers.removed();
      }
    });
    // Only the SDK's own message, and only from this extension. It always
    // returns `undefined` and never answers, so the extension's own
    // `onMessage` listeners and their response channels are unaffected.
    chrome.runtime?.onMessage?.addListener(
      (message: unknown, sender: chrome.runtime.MessageSender): undefined => {
        if (
          (message as { type?: unknown } | null)?.type ===
            PERMISSION_GRANTED_MESSAGE &&
          sender?.id === chrome.runtime.id
        ) {
          watcher.handlers.added();
        }
        return undefined;
      },
    );
  }
}
