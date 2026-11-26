import { ApiClient } from './api-client';
import { hasNotificationsApi } from './notification-permission';
import { NotificationsState } from './notifications-state';
import { FeedbackEventType, NormalizedNotification } from './types';

/**
 * Reports what happens to a notification to `POST /v1/feedback`:
 *
 * - shown → `delivered`
 * - clicked → `clicked`, then `opened` once the tab for its URL exists
 * - closed by the user (`byUser`) → `dismissed`
 * - closed by the system, timed auto-dismiss, or replaced by one with the
 *   same tag → nothing
 *
 * A legacy notification (no push-api id) is never reported.
 */
export class PushNotificationEvents {
  private static pushNotificationEvents: PushNotificationEvents;
  private api?: ApiClient;

  // Ids we clear programmatically (click / auto-dismiss / tag replacement).
  // chrome.notifications.clear() fires onClosed, which would otherwise report
  // a `dismissed` for a notification the user clicked or never closed. We
  // record the id before clearing and suppress that one onClosed. In-memory
  // is safe: clear() and its onClosed dispatch happen in the same worker
  // instance; `dismissSilently` covers the case where it does not. Genuine
  // user-closes are never in the set → still reported.
  private programmaticallyCleared = new Set<string>();

  private constructor() {}

  private listening = false;

  // Ids of the notifications this worker created. Together with the stored
  // entries they say which notifications are the SDK's: the listeners below
  // see every notification of the extension, and must leave alone the ones
  // the extension made itself. In memory because an entry may be missing
  // when storage could not be written; a notification from an earlier worker
  // is known by its stored entry.
  private created = new Set<string>();

  public static get instance() {
    if (!this.pushNotificationEvents) {
      this.pushNotificationEvents = new PushNotificationEvents();
    }
    return this.pushNotificationEvents;
  }

  /**
   * Adds the `chrome.notifications` listeners, once per worker, if the API is
   * there; resolves to whether they are in place. Called at top-level
   * service-worker startup, and again wherever the API may have appeared
   * since (the `notifications` permission was optional and has been granted).
   */
  public attachListeners(): boolean {
    if (this.listening) {
      return true;
    }
    if (!hasNotificationsApi()) {
      return false;
    }
    this.listening = true;
    this.listenForPushNotificationEvents();
    return true;
  }

  /** Re-initialising the SDK swaps the client; the listeners stay as they are. */
  public configure(api: ApiClient) {
    this.api = api;
  }

  /** Called before `chrome.notifications.create`. */
  public markCreated(notificationId: string) {
    this.created.add(notificationId);
  }

  /** Ids created by this worker that have not been closed yet. */
  public createdIds(): string[] {
    return [...this.created];
  }

  /** Resolves when the post is done. Never rejects. */
  public handleDisplayed(notification: NormalizedNotification): Promise<void> {
    return this.sendFeedback(notification.notificationId, 'delivered');
  }

  /**
   * Takes a notification off the screen without reporting anything. For a
   * notification whose stored entry is already gone (tag replacement);
   * otherwise use {@link dismissSilently}.
   */
  public clearSilently(notificationId: string) {
    // Never dropped here, even when nothing was on screen: an onClosed that
    // is already on its way must still find the id.
    this.programmaticallyCleared.add(notificationId);
    try {
      // Absent without the `notifications` permission: nothing is on screen.
      chrome.notifications?.clear(notificationId);
    } catch (error) {
      console.warn('[PushTo] could not clear notification', error);
    }
  }

  /**
   * {@link clearSilently}, after removing the stored entry. The set above
   * lives in memory: if the worker dies between clear() and its onClosed, the
   * fresh worker has an empty set, and the missing entry is what keeps it
   * from reporting a `dismissed`.
   */
  public async dismissSilently(notificationId: string) {
    this.programmaticallyCleared.add(notificationId);
    await this.forget(notificationId);
    this.clearSilently(notificationId);
  }

  private async forget(notificationId: string) {
    try {
      await NotificationsState.instance.removeNotification(notificationId);
    } catch (error) {
      console.warn('[PushTo] could not remove notification state', error);
    }
  }

  private async handleNotificationClick(notificationId: string) {
    // Before the first await: some platforms close a notification when it is
    // clicked, and that onClosed must not be taken for a dismissal.
    this.programmaticallyCleared.add(notificationId);

    // Read persisted state BEFORE removing and clearing it. The entry is in
    // chrome.storage.local, so a worker started by this very click finds it.
    let notification: NormalizedNotification | undefined;
    let stored = false;
    try {
      notification =
        await NotificationsState.instance.getNotification(notificationId);
      stored =
        notification !== undefined ||
        (await NotificationsState.instance.hasNotification(notificationId));
    } catch (error) {
      console.warn('[PushTo] could not read notification state', error);
    }

    // Not one of the SDK's: the extension's own notification. Nothing is
    // cleared, opened or reported.
    if (!stored && !this.created.has(notificationId)) {
      this.programmaticallyCleared.delete(notificationId);
      return;
    }

    const clicked = this.sendFeedback(notification?.notificationId, 'clicked');

    await this.dismissSilently(notificationId);

    if (notification?.badge) {
      await clearBadge();
    }

    let opened: Promise<void> | undefined;
    if (notification?.url) {
      try {
        await chrome.tabs.create({ url: notification.url });
        opened = this.sendFeedback(notification.notificationId, 'opened');
      } catch (error) {
        console.warn('[PushTo] could not open the notification url', error);
      }
    }

    await Promise.all([clicked, opened]);
  }

  private async handleNotificationClose(
    notificationId: string,
    byUser: boolean,
  ) {
    // A click, auto-dismiss or tag replacement called clear(), which is what
    // triggered this onClosed.
    const wasProgrammatic = this.programmaticallyCleared.delete(notificationId);
    const wasCreatedHere = this.created.delete(notificationId);

    // A failed read costs the `dismissed`, never the cleanup below.
    let notification: NormalizedNotification | undefined;
    let stored = false;
    try {
      notification =
        await NotificationsState.instance.getNotification(notificationId);
      stored =
        notification !== undefined ||
        (await NotificationsState.instance.hasNotification(notificationId));
    } catch (error) {
      console.warn('[PushTo] could not read notification state', error);
    }

    // Only a close the user made is a dismissal: push-api counts `dismissed`
    // against what the user is sent, so a close by the system must not be
    // one. A notification without a stored entry (legacy, or already handled
    // by a worker that has since died) reports nothing either; neither does
    // one the extension made itself, which has no entry.
    const dismissed =
      !wasProgrammatic && byUser === true
        ? this.sendFeedback(notification?.notificationId, 'dismissed')
        : undefined;

    // Every terminal path of an SDK notification funnels through onClosed,
    // so this is the cleanup point that keeps persisted state from growing
    // unbounded. Nothing is written for a notification that is not the
    // SDK's.
    if (stored || wasCreatedHere || wasProgrammatic) {
      await NotificationsState.instance.removeNotification(notificationId);
    }
    await dismissed;
  }

  // chrome.* events have no waitUntil; the handlers only have to make sure
  // nothing they start is left as an unhandled rejection.
  private listenForPushNotificationEvents() {
    chrome.notifications.onClicked.addListener((notificationId) => {
      this.handleNotificationClick(notificationId).catch((error) =>
        console.warn('[PushTo] notification click handler failed', error),
      );
    });

    chrome.notifications.onClosed.addListener((notificationId, byUser) => {
      this.handleNotificationClose(notificationId, byUser).catch((error) =>
        console.warn('[PushTo] notification close handler failed', error),
      );
    });
  }

  /**
   * Feedback is best effort: a failure is logged and swallowed, so the
   * returned promise never rejects.
   */
  private sendFeedback(
    notificationId: number | undefined,
    eventType: FeedbackEventType,
  ): Promise<void> {
    if (notificationId === undefined || !this.api) {
      return Promise.resolve();
    }
    return this.api
      .sendFeedback({
        notification_id: notificationId,
        event_type: eventType,
      })
      .catch((error) => {
        console.warn(
          `[PushTo] could not report "${eventType}" for notification ${notificationId}`,
          error,
        );
      });
  }
}

const BADGE_KEY = 'pt_badge';

/**
 * Sets the toolbar badge for a notification's `data.badge`, and records that
 * the badge is the SDK's, which is what allows {@link clearBadge} to clear
 * it. Without the record the badge is not set: one that could never be
 * cleared is worse than none. The toolbar badge only exists when the
 * manifest has an `action` key.
 */
export async function setBadge(text: string, color?: string) {
  if (!chrome.action) {
    return;
  }
  try {
    await chrome.storage.local.set({ [BADGE_KEY]: true });
  } catch (error) {
    console.warn('[PushTo] could not record the toolbar badge', error);
    return;
  }
  try {
    void Promise.resolve(chrome.action.setBadgeText({ text })).catch(
      () => undefined,
    );
    if (color) {
      void Promise.resolve(
        chrome.action.setBadgeBackgroundColor({ color }),
      ).catch(() => undefined);
    }
  } catch (error) {
    // An invalid color throws synchronously.
    console.warn('[PushTo] could not update the toolbar badge', error);
  }
}

/**
 * Clears the toolbar badge if the SDK set it and has not cleared it since.
 * A badge the extension set itself is left alone. Never rejects.
 */
export async function clearBadge() {
  try {
    const stored = await chrome.storage.local.get(BADGE_KEY);
    if (stored[BADGE_KEY] !== true) {
      return;
    }
    await chrome.storage.local.remove(BADGE_KEY);
    void Promise.resolve(chrome.action?.setBadgeText({ text: '' })).catch(
      () => undefined,
    );
  } catch (error) {
    console.warn('[PushTo] could not clear the toolbar badge', error);
  }
}
