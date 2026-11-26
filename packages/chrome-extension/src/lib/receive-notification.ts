declare let self: ServiceWorkerGlobalScope;

import { ApiClient } from './api-client';
import { Dismiss } from './dismiss';
import { hasNotificationsApi } from './notification-permission';
import { NotificationsState } from './notifications-state';
import { iconCandidates, normalizePayload } from './payload';
import {
  DeliveryBlock,
  PushNotificationStorage,
} from './push-notification-storage';
import {
  clearBadge,
  PushNotificationEvents,
  setBadge,
} from './push-notification-events';
import { NormalizedNotification, PushSubscriptionOptions } from './types';

export class ReceiveNotification {
  private static instance: ReceiveNotification;
  private defaultNotificationIcon?: string;

  // See `display`: one notification at a time.
  private queue: Promise<unknown> = Promise.resolve();

  // One function object each, added once per worker. Re-initialising the SDK
  // only changes what they read, so it can never leave a second listener.
  private readonly onPush = (event: PushEvent) =>
    this.handlePushNotification(event);
  private readonly onActionClicked = () => void clearBadge();

  private constructor() {}

  /**
   * Must run synchronously at top-level service-worker startup: MV3 only
   * delivers a wake event (push, alarm, notification click) to listeners
   * registered then.
   */
  public static initialize(api: ApiClient, options: PushSubscriptionOptions) {
    if (!this.instance) {
      this.instance = new ReceiveNotification();
      self.addEventListener('push', this.instance.onPush);
      // Absent when the manifest has no `action` key.
      chrome.action?.onClicked?.addListener(this.instance.onActionClicked);
    }
    this.instance.defaultNotificationIcon = options.defaultNotificationIcon;

    PushNotificationEvents.instance.configure(api);

    // The alarm listener and the chrome.notifications ones, at top-level SW
    // startup: a worker woken solely by an alarm or a notification click has
    // to have them by the time the event is dispatched.
    this.attachNotificationListeners();

    return this.instance;
  }

  /**
   * Adds whichever of the SDK's `chrome.notifications` (and alarm) listeners
   * are still missing, and resolves to whether `chrome.notifications` can be
   * used. With `notifications` as an optional permission the API is absent
   * until the grant, so this runs at startup, when `permissions.onAdded`
   * reports the grant, and before a notification is displayed. Each listener
   * is added at most once per worker.
   */
  public static attachNotificationListeners(): boolean {
    Dismiss.instance.registerListeners();
    return PushNotificationEvents.instance.attachListeners();
  }

  private handlePushNotification(event: PushEvent) {
    if (!event.data) {
      return;
    }

    let raw: unknown;
    try {
      raw = event.data.json();
    } catch {
      console.warn('[PushTo] ignoring a push message that is not JSON');
      return;
    }

    const notification = normalizePayload(raw);
    if (!notification) {
      console.warn('[PushTo] ignoring a push message of an unknown shape');
      return;
    }

    // Everything showNotification starts, the `delivered` post included, is
    // awaited inside it, so waitUntil keeps the worker alive for all of it.
    event.waitUntil(
      this.showNotification(notification).catch((error) =>
        console.warn('[PushTo] could not show the notification', error),
      ),
    );
  }

  private async showNotification(notification: NormalizedNotification) {
    // The API may have appeared since startup without a `permissions.onAdded`
    // (see notification-permission.ts). Without it nothing can be shown.
    if (
      !ReceiveNotification.attachNotificationListeners() ||
      !hasNotificationsApi()
    ) {
      console.warn(
        '[PushTo] a push message arrived but chrome.notifications is not available (the `notifications` permission is not granted): nothing is shown',
      );
      return;
    }

    // After `unsubscribe()`, and while a sign-out or a switch of user has not
    // been confirmed by the API, what arrives is not for whoever is at this
    // browser now: nothing is shown and nothing is reported. If the state
    // cannot be read the notification is shown, like everywhere else where
    // storage is only bookkeeping.
    let block: DeliveryBlock | undefined;
    try {
      block = await PushNotificationStorage.deliveryBlock();
    } catch (error) {
      console.warn('[PushTo] could not read the delivery state', error);
    }
    if (block) {
      console.warn(
        block === 'opted_out'
          ? '[PushTo] a push message arrived after unsubscribe(): nothing is shown'
          : '[PushTo] a push message arrived while a change of user is not yet registered: nothing is shown',
      );
      return;
    }

    const { id } = notification;
    const options: Omit<
      chrome.notifications.NotificationCreateOptions,
      'iconUrl'
    > = {
      title: notification.title,
      message: notification.message,
      priority: 1,
      type: 'basic',
      isClickable: true,
    };

    if (notification.contextMessage) {
      options.contextMessage = notification.contextMessage;
    }

    if (notification.requireInteraction) {
      options.requireInteraction = true;
    }

    // Feedback, auto-dismiss and badge stay out of the queue: a slow network
    // must not delay the next notification.
    const task = () => this.display(notification, options);
    const result = this.queue.then(task, task);
    this.queue = result.catch(() => undefined);
    if (!(await result)) {
      return;
    }

    const delivered =
      PushNotificationEvents.instance.handleDisplayed(notification);

    if (notification.autoDismissMs !== undefined) {
      try {
        await Dismiss.instance.handleTimedAutoDismiss(
          id,
          notification.autoDismissMs,
        );
      } catch (error) {
        console.warn('[PushTo] could not schedule the auto-dismiss', error);
      }
    }

    if (notification.badge) {
      await setBadge(notification.badge.text, notification.badge.color);
    }

    await delivered;
  }

  /**
   * Persists, shows, then replaces the notifications with the same tag.
   * Resolves to whether the notification is on screen.
   *
   * Runs one notification at a time (see `showNotification`): two pushes with
   * the same tag handled together would otherwise each look for the other
   * before it is stored, and both would stay.
   */
  private async display(
    notification: NormalizedNotification,
    options: Omit<chrome.notifications.NotificationCreateOptions, 'iconUrl'>,
  ): Promise<boolean> {
    const { id, tag } = notification;

    // Persist before showing, so a click that comes at once finds the entry.
    // Storage is bookkeeping, though: if it fails (quota, a damaged profile)
    // the notification is still shown, only without its click target and
    // feedback.
    try {
      await NotificationsState.instance.addNotification(id, notification);
    } catch (error) {
      console.warn('[PushTo] could not persist the notification state', error);
    }

    PushNotificationEvents.instance.markCreated(id);
    const shown = await this.createWithIconFallback(
      id,
      options,
      iconCandidates(this.defaultNotificationIcon, notification.icon),
    );
    if (!shown) {
      await NotificationsState.instance
        .removeNotification(id)
        .catch(() => undefined);
      return false;
    }

    // Only now: had the new one failed to show, the ones it replaces would
    // have been taken away for nothing.
    if (tag) {
      try {
        const replaced =
          await NotificationsState.instance.removeNotificationsByTag(tag, id);
        for (const replacedId of replaced) {
          PushNotificationEvents.instance.clearSilently(replacedId);
        }
      } catch (error) {
        console.warn(
          '[PushTo] could not replace the notifications with the same tag',
          error,
        );
      }
    }
    return true;
  }

  /**
   * `chrome.notifications.create` fails when the icon cannot be loaded, and a
   * notification that is not shown is worse than one with a plainer icon: on
   * failure the next candidate is tried.
   */
  private async createWithIconFallback(
    id: string,
    options: Omit<chrome.notifications.NotificationCreateOptions, 'iconUrl'>,
    icons: string[],
  ): Promise<boolean> {
    let lastError: unknown;
    for (const iconUrl of icons) {
      try {
        await createNotification(id, { ...options, iconUrl });
        return true;
      } catch (error) {
        lastError = error;
      }
    }
    console.warn('[PushTo] chrome.notifications.create failed', lastError);
    return false;
  }
}

/**
 * Takes every notification the SDK has on screen away, with its stored
 * entry and auto-dismiss alarm, and clears the SDK's badge. Nothing is
 * reported: the user did not dismiss them. Notifications the extension made
 * itself are not touched. Never rejects.
 */
export async function clearDisplayedNotifications(): Promise<void> {
  // The stored ones, and the ones this worker showed without being able to
  // store them.
  const ids = new Set(PushNotificationEvents.instance.createdIds());
  try {
    for (const id of await NotificationsState.instance.listIds()) {
      ids.add(id);
    }
  } catch (error) {
    console.warn('[PushTo] could not list the notifications on screen', error);
  }
  for (const id of ids) {
    // One that fails must not leave the others on screen.
    try {
      await Dismiss.instance.handleNotificationClose(id).catch(() => undefined);
      await PushNotificationEvents.instance.dismissSilently(id);
    } catch (error) {
      console.warn('[PushTo] could not clear a notification', error);
    }
  }
  await clearBadge();
}

function createNotification(
  id: string,
  options: chrome.notifications.NotificationCreateOptions,
): Promise<void> {
  return new Promise((resolve, reject) => {
    chrome.notifications.create(id, options, () => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message ?? 'unknown error'));
      } else {
        resolve();
      }
    });
  });
}
