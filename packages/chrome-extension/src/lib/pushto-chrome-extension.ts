/// <reference types="chrome"/>
/// <reference lib="webworker" />
declare let self: ServiceWorkerGlobalScope;

import { PushSubscriptionOptions } from './types';
import { RegisterSubscription } from './register-subscription';
import { ReceiveNotification } from './receive-notification';
import { PushNotificationEvents } from './events';

export class PushNotifications {
  private apiKey: string;

  constructor(options: PushSubscriptionOptions) {
    this.apiKey = options.apiKey;

    ReceiveNotification.initialize(options);
    console.log('PushNotifications initialized');
    PushNotificationEvents.initialize();
    console.log('PushNotificationEvents initialized');
  }

  public async registerPushSubscription() {
    console.log('registerPushSubscription');
    const registerSubscription = new RegisterSubscription(this.apiKey);
    await registerSubscription.registerPushSubscription();
  }
}
