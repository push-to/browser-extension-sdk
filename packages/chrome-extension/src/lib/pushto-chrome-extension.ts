declare let self: ServiceWorkerGlobalScope;

import { PushSubscriptionOptions, User } from './types';
import { RegisterSubscription } from './register-subscription';
import { ReceiveNotification } from './receive-notification';

const currentUrlPromise = new Promise<string>((resolve) => {
  function handleFetch(event: FetchEvent) {
    resolve(event.request.url);

    self.removeEventListener('fetch', handleFetch);
  }

  self.addEventListener('fetch', handleFetch);
});

export class PushNotifications {
  private apiKey: string;

  constructor(options: PushSubscriptionOptions) {
    this.apiKey = options.apiKey;

    ReceiveNotification.initialize(this.apiKey, options);
  }

  public async registerPushSubscription(user?: User) {
    const registerSubscription = new RegisterSubscription(this.apiKey);

    const currentUrl = await currentUrlPromise;
    await registerSubscription.registerPushSubscription(currentUrl, user);
  }
}

export type { User };
