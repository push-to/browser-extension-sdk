/// <reference types="chrome"/>
/// <reference lib="webworker" />
declare let self: ServiceWorkerGlobalScope;

import { PushNotificationData, PushSubscriptionOptions } from './types';

export class ReceiveNotification {
  private static instance: ReceiveNotification;
  private defaultNotificationIcon?: string;

  private constructor(options: PushSubscriptionOptions) {
    this.defaultNotificationIcon = options.defaultNotificationIcon;
  }

  public static initialize(options: PushSubscriptionOptions) {
    if (
      !this.instance ||
      this.instance.defaultNotificationIcon !== options.defaultNotificationIcon
    ) {
      if (this.instance) {
        this.instance.removeListener();
      }

      this.instance = new ReceiveNotification(options);

      this.instance.listenForPushNotifications();
    }
    return this.instance;
  }

  private handlePushNotification(event: PushEvent) {
    console.log('handlePushNotification');
    if (event.data === null) {
      return;
    }

    const data = event.data.json() as PushNotificationData;

    console.log('data', data);

    this.showNotification(data);
  }

  private removeListener() {
    self.removeEventListener('push', this.handlePushNotification);
  }

  private listenForPushNotifications() {
    console.log('listenForPushNotifications');
    self.addEventListener('push', this.handlePushNotification.bind(this));
  }

  private async showNotification(data: PushNotificationData) {
    const title = data.title;
    const body = data.options.body;
    const icon = this.defaultNotificationIcon ?? data.options.icon;

    const options: chrome.notifications.NotificationOptions<true> = {
      priority: 1,
      type: 'basic',
      isClickable: true,
      title,
      message: body,
      iconUrl: icon,
    };

    console.log('options', options);

    chrome.notifications.create(
      data.options.data.correlationId,
      options,
      (notificationId) => {
        console.info(`Notification created with id: ${notificationId}`);
      }
    );

    // if (data.badge) {
    //   chrome.action.setBadgeText({ text: data.badge.text });
    //   chrome.action.setBadgeBackgroundColor({ color: data.badge.color });
    // }
  }
}
