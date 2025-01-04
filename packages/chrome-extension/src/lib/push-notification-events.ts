/// <reference types="chrome"/>
/// <reference lib="webworker" />
declare let self: ServiceWorkerGlobalScope;

import { CORE_URL } from './constants';
import { PushNotificationStatus } from './types';

export class PushNotificationEvents {
  private static pushNotificationEvents: PushNotificationEvents;
  private trackNotificationUrl: string = CORE_URL + '/track-notification';

  constructor(private readonly apiKey: string) {}

  public static getInstance(apiKey: string) {
    if (!this.pushNotificationEvents) {
      this.pushNotificationEvents = new PushNotificationEvents(apiKey);

      this.pushNotificationEvents.listenForPushNotificationEvents();
    }

    return this.pushNotificationEvents;
  }

  public handleDisplayed(notificationId: string) {
    this.sendTrackNotificationEvent(
      notificationId,
      PushNotificationStatus.DELIVERED
    );
  }

  public handleAutoDismissed(notificationId: string) {
    this.sendTrackNotificationEvent(
      notificationId,
      PushNotificationStatus.AUTO_DISMISSED
    );
  }

  private handleNotificationClick(notificationId: string) {
    this.sendTrackNotificationEvent(
      notificationId,
      PushNotificationStatus.CLICKED
    );
  }

  private handleNotificationClose(notificationId: string, _byUser: boolean) {
    this.sendTrackNotificationEvent(
      notificationId,
      PushNotificationStatus.CLOSED
    );
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
    status: PushNotificationStatus
  ) {
    await fetch(this.trackNotificationUrl, {
      method: 'POST',
      body: JSON.stringify({ correlationId: notificationId, status }),
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
    });
  }
}
