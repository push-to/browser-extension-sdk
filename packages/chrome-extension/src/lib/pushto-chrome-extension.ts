/// <reference types="chrome"/>
/// <reference lib="webworker" />
declare let self: ServiceWorkerGlobalScope;

import { PushSubscriptionOptions } from './types';
import { RegisterSubscription } from './register-subscription';
import { ReceiveNotification } from './receive-notification';

export class PushNotifications {
  private apiKey: string;

  constructor(options: PushSubscriptionOptions) {
    this.apiKey = options.apiKey;

    ReceiveNotification.initialize(this.apiKey, options);
  }

  public async registerPushSubscription() {
    const registerSubscription = new RegisterSubscription(this.apiKey);
    await registerSubscription.registerPushSubscription();
  }
}
