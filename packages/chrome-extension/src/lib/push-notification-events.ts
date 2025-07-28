import { CORE_URL } from './constants';
import { NotificationsState } from './notifications-state';
import { PushNotificationStatus } from './types';

export class PushNotificationEvents {
  private static pushNotificationEvents: PushNotificationEvents;
  private trackNotificationUrl: string = CORE_URL + '/notifications/track';

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
      PushNotificationStatus.DELIVERED,
    );
  }

  public handleAutoDismissed(notificationId: string) {
    this.sendTrackNotificationEvent(
      notificationId,
      PushNotificationStatus.AUTO_DISMISSED,
    );

    chrome.notifications.clear(notificationId);
  }

  private handleNotificationClick(notificationId: string) {
    this.sendTrackNotificationEvent(
      notificationId,
      PushNotificationStatus.CLICKED,
    );

    chrome.notifications.clear(notificationId);

    const notification =
      NotificationsState.instance.getNotification(notificationId);

    if (notification?.options?.data?.link) {
      chrome.tabs.create({ url: notification.options.data.link });
    }

    if (notification?.options?.data?.badge) {
      chrome.action.setBadgeText({ text: '' });
    }
  }

  private handleNotificationClose(notificationId: string, _byUser: boolean) {
    this.sendTrackNotificationEvent(
      notificationId,
      PushNotificationStatus.CLOSED,
    );
  }

  private listenForPushNotificationEvents() {
    chrome.notifications.onClicked.addListener(
      this.handleNotificationClick.bind(this),
    );

    chrome.notifications.onClosed.addListener(
      this.handleNotificationClose.bind(this),
    );
  }

  private async sendTrackNotificationEvent(
    notificationId: string,
    status: PushNotificationStatus,
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
