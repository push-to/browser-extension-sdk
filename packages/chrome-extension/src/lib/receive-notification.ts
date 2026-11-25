declare let self: ServiceWorkerGlobalScope;

import { ApiClient } from './api-client';
import { Dismiss } from './dismiss';
import { NotificationsState } from './notifications-state';
import { iconCandidates, normalizePayload } from './payload';
import {
  clearBadge,
  PushNotificationEvents,
  setBadge,
} from './push-notification-events';
import { NormalizedNotification, PushSubscriptionOptions } from './types';

export class ReceiveNotification {
  private static instance: ReceiveNotification;
  private defaultNotificationIcon?: string;

  // One function object each, added once per worker. Re-initialising the SDK
  // only changes what they read, so it can never leave a second listener.
  private readonly onPush = (event: PushEvent) =>
    this.handlePushNotification(event);
  private readonly onActionClicked = () => clearBadge();

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

    // Register the durable-dismiss alarm listener at top-level SW startup so a
    // worker re-woken by an alarm it never scheduled can still handle it.
    Dismiss.instance.registerListeners();

    // Wire chrome.notifications.onClicked/onClosed at top-level startup too.
    // The first `instance` access registers those listeners; without this a
    // worker woken solely by a notification click would have no onClicked
    // listener at dispatch time and the click would be lost.
    PushNotificationEvents.instance.configure(api);

    return this.instance;
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

    // Persist before showing, so a click that comes at once finds the entry.
    // Storage is bookkeeping, though: if it fails (quota, a damaged profile)
    // the notification is still shown, only without its click target and
    // feedback.
    try {
      if (notification.tag) {
        const replaced =
          await NotificationsState.instance.removeNotificationsByTag(
            notification.tag,
            id,
          );
        for (const replacedId of replaced) {
          PushNotificationEvents.instance.clearSilently(replacedId);
        }
      }
      await NotificationsState.instance.addNotification(id, notification);
    } catch (error) {
      console.warn('[PushTo] could not persist the notification state', error);
    }

    const shown = await this.createWithIconFallback(
      id,
      options,
      iconCandidates(this.defaultNotificationIcon, notification.icon),
    );
    if (!shown) {
      await NotificationsState.instance
        .removeNotification(id)
        .catch(() => undefined);
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
      setBadge(notification.badge.text, notification.badge.color);
    }

    await delivered;
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
