import { PushNotificationEvents } from './push-notification-events';
import { PushNotificationData } from './types';

/**
 * Persistent store for in-flight notifications.
 *
 * MV3 service workers are ephemeral: an idle worker is terminated and a fresh
 * instance is spun up to handle the next push/click. An in-memory `Map` does
 * not survive that, so notification metadata is persisted in
 * `chrome.storage.local` and read back on demand. Every method is async as a
 * result. Values are plain `PushNotificationData` objects, so the JSON
 * round-trip performed by `chrome.storage` is lossless.
 */
export class NotificationsState {
  private static notificationsState: NotificationsState;
  private static readonly STORAGE_KEY = 'pt_notifications';

  private constructor() {}

  public static get instance() {
    if (!this.notificationsState) {
      this.notificationsState = new NotificationsState();
    }
    return this.notificationsState;
  }

  private async readAll(): Promise<Record<string, PushNotificationData>> {
    const stored = await chrome.storage.local.get(
      NotificationsState.STORAGE_KEY,
    );
    return (
      (stored[NotificationsState.STORAGE_KEY] as
        | Record<string, PushNotificationData>
        | undefined) ?? {}
    );
  }

  private async writeAll(
    notifications: Record<string, PushNotificationData>,
  ): Promise<void> {
    await chrome.storage.local.set({
      [NotificationsState.STORAGE_KEY]: notifications,
    });
  }

  public async addNotification(
    notificationId: string,
    notification: PushNotificationData,
  ): Promise<void> {
    const notifications = await this.readAll();
    notifications[notificationId] = notification;
    await this.writeAll(notifications);
  }

  public async removeNotification(notificationId: string): Promise<void> {
    const notifications = await this.readAll();
    if (notificationId in notifications) {
      delete notifications[notificationId];
      await this.writeAll(notifications);
    }
  }

  public async getNotifications(): Promise<
    Record<string, PushNotificationData>
  > {
    return this.readAll();
  }

  public async getNotification(
    notificationId: string,
  ): Promise<PushNotificationData | undefined> {
    const notifications = await this.readAll();
    return notifications[notificationId];
  }

  public async removeNotificationsByTag(
    apiKey: string,
    tag: string,
  ): Promise<void> {
    const notifications = await this.readAll();
    let changed = false;

    for (const [notificationId, notification] of Object.entries(
      notifications,
    )) {
      if (notification.options.data.tag === tag) {
        delete notifications[notificationId];
        changed = true;
        PushNotificationEvents.getInstance(apiKey).handleAutoDismissed(
          notificationId,
        );
      }
    }

    if (changed) {
      await this.writeAll(notifications);
    }
  }
}
