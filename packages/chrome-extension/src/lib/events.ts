/// <reference types="chrome"/>
/// <reference lib="webworker" />
declare let self: ServiceWorkerGlobalScope;

export class PushNotificationEvents {
  private static instance: PushNotificationEvents;

  public static initialize() {
    if (!this.instance) {
      this.instance = new PushNotificationEvents();

      this.instance.listenForPushNotificationEvents();
    }

    return this.instance;
  }

  private handleShow(event: Event) {
    console.log('push notification event: show', event);
  }

  private handleNotificationClick(event: NotificationEvent) {
    console.log('push notification event: notificationclick', event);
  }

  private handleNotificationClose(event: NotificationEvent) {
    console.log('push notification event: notificationclose', event);
  }

  private handleMessageError(event: MessageEvent) {
    console.log('push notification event: messageerror', event);
  }

  private listenForPushNotificationEvents() {
    self.addEventListener('show', this.handleShow);
    self.addEventListener('notificationclick', this.handleNotificationClick);
    self.addEventListener('notificationclose', this.handleNotificationClose);
    self.addEventListener('messageerror', this.handleMessageError);

    chrome.notifications.onClicked.addListener((notificationId) => {
      console.log(
        'new push notification event:Notification clicked:',
        notificationId
      );
    });

    chrome.notifications.onClosed.addListener((notificationId) => {
      console.log(
        'new push notification event:Notification closed:',
        notificationId
      );
    });

    chrome.notifications.onShowSettings.addListener(() => {
      console.log('new push notification event:Notification show settings');
    });

    chrome.notifications.onButtonClicked.addListener(
      (notificationId, buttonIndex) => {
        console.log(
          'new push notification event:Notification button clicked:',
          notificationId,
          buttonIndex
        );
      }
    );

    chrome.notifications.onPermissionLevelChanged.addListener(
      (permissionLevel) => {
        console.log(
          'new push notification event:Notification permission level changed:',
          permissionLevel
        );
      }
    );
  }
}
