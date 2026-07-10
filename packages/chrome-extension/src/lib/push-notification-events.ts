import { CORE_URL } from './constants';
import { NotificationsState } from './notifications-state';
import { PushNotificationStatus } from './types';

export class PushNotificationEvents {
  private static pushNotificationEvents: PushNotificationEvents;
  private trackNotificationUrl: string = CORE_URL + '/notifications/track';

  // Ids we clear programmatically (click / auto-dismiss). chrome.notifications
  // .clear() fires onClosed, which would otherwise send a trailing CLOSED that
  // overwrites the CLICKED/AUTO_DISMISSED row (core's track is last-write-wins
  // on the same id). We record the id before clearing and suppress that one
  // CLOSED. In-memory is safe: clear() and its onClosed dispatch happen in the
  // same worker instance. Genuine user-closes are never in the set → still
  // tracked as CLOSED.
  private programmaticallyCleared = new Set<string>();

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

    this.programmaticallyCleared.add(notificationId);
    chrome.notifications.clear(notificationId);
  }

  private async handleNotificationClick(notificationId: string) {
    // Read persisted state BEFORE clearing: clear() triggers onClosed, which
    // removes the entry from chrome.storage.local. Reading first guarantees the
    // link/badge metadata is available even if the removal wins the race.
    const notification =
      await NotificationsState.instance.getNotification(notificationId);

    this.sendTrackNotificationEvent(
      notificationId,
      PushNotificationStatus.CLICKED,
    );

    this.programmaticallyCleared.add(notificationId);
    chrome.notifications.clear(notificationId);

    if (notification?.options?.data?.link) {
      chrome.tabs.create({ url: notification.options.data.link });
    }

    if (notification?.options?.data?.badge) {
      chrome.action.setBadgeText({ text: '' });
    }
  }

  private async handleNotificationClose(
    notificationId: string,
    _byUser: boolean,
  ) {
    // A click/auto-dismiss already tracked CLICKED/AUTO_DISMISSED and then
    // called clear(), which is what triggered this onClosed. Suppress the
    // trailing CLOSED so it doesn't overwrite that row; only genuine
    // user-initiated closes (not in the set) are tracked as CLOSED.
    const wasProgrammatic = this.programmaticallyCleared.delete(notificationId);
    if (!wasProgrammatic) {
      this.sendTrackNotificationEvent(
        notificationId,
        PushNotificationStatus.CLOSED,
      );
    }

    // Every terminal path (click, auto-dismiss, user-close) funnels through
    // onClosed, so this is the single cleanup point that keeps persisted state
    // from growing unbounded now that it survives worker termination.
    await NotificationsState.instance.removeNotification(notificationId);
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
