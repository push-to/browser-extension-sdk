/// <reference types="chrome"/>
/// <reference lib="webworker" />
declare let self: ServiceWorkerGlobalScope;

import { AUTH_TOKEN, CORE_URL } from './constants';

export class PushNotificationEvents {
  private static pushNotificationEvents: PushNotificationEvents;
  private trackNotificationUrl: string = CORE_URL + '/track-notification';
  private authToken: string = AUTH_TOKEN;

  constructor(private readonly apiKey: string) {}

  public static getInstance(apiKey: string) {
    if (!this.pushNotificationEvents) {
      this.pushNotificationEvents = new PushNotificationEvents(apiKey);

      this.pushNotificationEvents.listenForPushNotificationEvents();
    }

    return this.pushNotificationEvents;
  }

  public handleDisplayed(notificationId: string) {
    this.sendTrackNotificationEvent(notificationId, 'displayed');
  }

  private handleNotificationClick(notificationId: string) {
    this.sendTrackNotificationEvent(notificationId, 'clicked');
  }

  private handleNotificationClose(notificationId: string, _byUser: boolean) {
    this.sendTrackNotificationEvent(notificationId, 'closed');
  }

  private listenForPushNotificationEvents() {
    chrome.notifications.onClicked.addListener(
      this.handleNotificationClick.bind(this)
    );

    chrome.notifications.onClosed.addListener(
      this.handleNotificationClose.bind(this)
    );
  }

  private async sendTrackNotificationEvent(
    notificationId: string,
    status: 'clicked' | 'displayed' | 'closed'
  ) {
    await fetch(this.trackNotificationUrl, {
      method: 'POST',
      body: JSON.stringify({ correlationId: notificationId, status }),
      headers: {
        'Content-Type': 'application/json',
        Authorization: this.authToken,
        'x-pushto-api-key': this.apiKey,
      },
    });
  }
}
