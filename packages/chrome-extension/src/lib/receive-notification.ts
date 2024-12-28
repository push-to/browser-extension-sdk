/// <reference types="chrome"/>
/// <reference lib="webworker" />
declare let self: ServiceWorkerGlobalScope;

import { PushNotificationData, PushSubscriptionOptions } from './types';

export class ReceiveNotification {
  private static receiveNotificationInstance: ReceiveNotification;
  private defaultNotificationIcon?: string;

  private constructor(options: PushSubscriptionOptions) {
    this.defaultNotificationIcon = options.defaultNotificationIcon;
  }

  public static initialize(options: PushSubscriptionOptions) {
    if (
      !this.receiveNotificationInstance ||
      this.receiveNotificationInstance.defaultNotificationIcon !==
        options.defaultNotificationIcon
    ) {
      if (this.receiveNotificationInstance) {
        this.receiveNotificationInstance.removeListener();
      }

      this.receiveNotificationInstance = new ReceiveNotification(options);

      this.receiveNotificationInstance.listenForPushNotifications();
    }
    return this.receiveNotificationInstance;
  }

  private handlePushNotification(event: PushEvent) {
    if (event.data === null) {
      return;
    }

    const data = event.data.json() as PushNotificationData;

    this.showNotification(data);
  }

  private removeListener() {
    self.removeEventListener('push', this.handlePushNotification);
  }

  private listenForPushNotifications() {
    self.addEventListener('push', this.handlePushNotification);
  }

  private async showNotification(data: PushNotificationData) {
    const title = data.title;
    const body = data.body;
    const icon = this.defaultNotificationIcon ?? data.icon;

    const options: chrome.notifications.NotificationOptions<true> = {
      priority: 1,
      type: 'basic',
      isClickable: true,
      title,
      message: body,
      iconUrl: icon,
    };

    chrome.notifications.create(
      'push-to-chrome-extension',
      options,
      (notificationId) => {
        console.info(`Notification created with id: ${notificationId}`);
      }
    );

    if (data.badge) {
      chrome.action.setBadgeText({ text: data.badge.text });
      chrome.action.setBadgeBackgroundColor({ color: data.badge.color });
    }
  }
}
