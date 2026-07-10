declare let self: ServiceWorkerGlobalScope;

import { Dismiss } from './dismiss';
import { NotificationsState } from './notifications-state';
import { PushNotificationEvents } from './push-notification-events';
import { PushNotificationData, PushSubscriptionOptions } from './types';

export class ReceiveNotification {
  private static instance: ReceiveNotification;
  private defaultNotificationIcon?: string;

  private constructor(
    private readonly apiKey: string,
    options: PushSubscriptionOptions,
  ) {
    this.defaultNotificationIcon = options.defaultNotificationIcon;
  }

  public static initialize(apiKey: string, options: PushSubscriptionOptions) {
    if (
      !this.instance ||
      this.instance.defaultNotificationIcon !== options.defaultNotificationIcon
    ) {
      if (this.instance) {
        this.instance.removeListener();
      }

      this.instance = new ReceiveNotification(apiKey, options);

      this.instance.listenForPushNotifications();
      this.instance.listenForAction();

      // Register the durable-dismiss alarm listener at top-level SW startup so a
      // worker re-woken by an alarm it never scheduled can still handle it.
      Dismiss.instance.registerListeners(apiKey);

      // Wire chrome.notifications.onClicked/onClosed at top-level startup too.
      // getInstance() registers those listeners; without this a worker woken
      // solely by a notification click would have no onClicked listener at
      // dispatch time and the click (track + link + badge-clear) would be lost.
      PushNotificationEvents.getInstance(apiKey);
    }
    return this.instance;
  }

  private listenForAction() {
    chrome.action.onClicked.addListener(() => {
      chrome.action.setBadgeText({ text: '' });
    });
  }

  private handlePushNotification(event: PushEvent) {
    if (event.data === null) {
      return;
    }

    event.waitUntil(this.showNotification(event.data.json()));
  }

  private removeListener() {
    self.removeEventListener('push', this.handlePushNotification);
  }

  private listenForPushNotifications() {
    self.addEventListener('push', this.handlePushNotification.bind(this));
  }

  private async showNotification(data: PushNotificationData) {
    const title = data.title;
    const body = data.options.body;
    const icon = this.defaultNotificationIcon ?? data.options.icon;

    const options: chrome.notifications.NotificationCreateOptions = {
      title,
      message: body,
      priority: 1,
      type: 'basic',
      isClickable: true,
      iconUrl: icon,
    };

    if (data.options.contextMessage) {
      options.contextMessage = data.options.contextMessage;
    }

    if (data.options.data?.autoDismissOptions?.behavior === 'device_default') {
      options.requireInteraction = true;
    }

    if (data.options.data?.tag) {
      await NotificationsState.instance.removeNotificationsByTag(
        this.apiKey,
        data.options.data.tag,
      );
    }

    chrome.notifications.create(data.options.data.correlationId, options);

    await NotificationsState.instance.addNotification(
      data.options.data.correlationId,
      data,
    );

    PushNotificationEvents.getInstance(this.apiKey).handleDisplayed(
      data.options.data.correlationId,
    );

    if (data.options?.data?.autoDismissOptions?.behavior === 'timed') {
      Dismiss.instance.handleTimedAutoDismiss(
        this.apiKey,
        data.options.data.correlationId,
        data.options.data.autoDismissOptions,
      );
    }

    if (data.options.data.badge) {
      chrome.action.setBadgeText({ text: data.options.data.badge.text });
      chrome.action.setBadgeBackgroundColor({
        color: data.options.data.badge.color,
      });
    }
  }
}
