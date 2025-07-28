import { PushNotificationEvents } from './push-notification-events';
import { AutoDismissOptions } from './types';

export class Dismiss {
  private static dismiss: Dismiss;
  private dismissTimeoutIDsCache = new Map<string, NodeJS.Timeout>();

  private constructor() {}

  public static get instance() {
    if (!this.dismiss) {
      this.dismiss = new Dismiss();
    }
    return this.dismiss;
  }

  public async handleTimedAutoDismiss(
    apiKey: string,
    correlationId: string,
    autoDismissOptions: AutoDismissOptions,
  ) {
    if (autoDismissOptions?.behavior === 'timed') {
      const dismissTimeoutID = setTimeout(async () => {
        const notificationsIds = await this.getNotifications();

        console.log('notifications', notificationsIds);

        const notification = notificationsIds.find(
          (notification) => notification === correlationId,
        );

        if (notification) {
          PushNotificationEvents.getInstance(apiKey).handleAutoDismissed(
            correlationId,
          );
        } else {
          this.dismissTimeoutIDsCache.delete(correlationId);
        }
      }, autoDismissOptions.dismissTimeMS);

      this.dismissTimeoutIDsCache.set(correlationId, dismissTimeoutID);
    }
  }

  private async getNotifications(): Promise<string[]> {
    return new Promise((resolve, reject) => {
      chrome.notifications.getAll((notificationsObj) => {
        const notifications = Object.keys(notificationsObj);
        resolve(notifications);
      });
    });
  }

  public handleNotificationClose(correlationId: string) {
    const dismissTimeoutID = this.dismissTimeoutIDsCache.get(correlationId);
    if (dismissTimeoutID) {
      clearTimeout(dismissTimeoutID);
      this.dismissTimeoutIDsCache.delete(correlationId);
    }
  }
}
