import { PushNotificationEvents } from './push-notification-events';
import { PushNotificationData } from './types';

export class NotificationsState {
  private static notificationsState: NotificationsState;
  private notifications: Map<string, PushNotificationData> = new Map();

  private constructor() {}

  public static get instance() {
    if (!this.notificationsState) {
      this.notificationsState = new NotificationsState();
    }
    return this.notificationsState;
  }

  public addNotification(
    notificationId: string,
    notification: PushNotificationData
  ) {
    this.notifications.set(notificationId, notification);
  }

  public removeNotification(notificationId: string) {
    this.notifications.delete(notificationId);
  }

  public getNotifications() {
    return this.notifications;
  }

  public getNotification(notificationId: string) {
    return this.notifications.get(notificationId);
  }

  public removeNotificationsByTag(apiKey: string, tag: string) {
    this.notifications.forEach((notification, notificationId) => {
      if (notification.options.data.tag === tag) {
        this.removeNotification(notificationId);
        PushNotificationEvents.getInstance(apiKey).handleAutoDismissed(
          notificationId
        );
      }
    });
  }
}
