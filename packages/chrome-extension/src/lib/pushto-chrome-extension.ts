declare let self: ServiceWorkerGlobalScope;

import { PushSubscriptionOptions, User } from './types';
import { RegisterSubscription } from './register-subscription';
import { ReceiveNotification } from './receive-notification';

const currentUrlPromise = new Promise<string>((resolve, reject) => {
  // Set a timeout to prevent hanging indefinitely if no fetch event occurs
  const timeoutId = setTimeout(() => {
    self.removeEventListener('fetch', handleFetch);
    reject(new Error(
      'Service Worker fetch event did not fire within expected time. ' +
      'The Service Worker may not be properly activated or no navigation has occurred.'
    ));
  }, 10000); // 10 second timeout

  function handleFetch(event: FetchEvent) {
    clearTimeout(timeoutId);
    resolve(event.request.url);

    self.removeEventListener('fetch', handleFetch);
  }

  self.addEventListener('fetch', handleFetch);
});

export class PushNotifications {
  private apiKey: string;

  constructor(options: PushSubscriptionOptions) {
    // Verify Service Worker context
    if (typeof self === 'undefined' || !('ServiceWorkerGlobalScope' in globalThis)) {
      throw new Error(
        'PushNotifications must be initialized in a Service Worker context. Ensure this code is running in your extension\'s service worker file.'
      );
    }

    this.apiKey = options.apiKey;

    ReceiveNotification.initialize(this.apiKey, options);
  }

  public async registerPushSubscription(user?: User) {
    const registerSubscription = new RegisterSubscription(this.apiKey);

    let currentUrl: string;
    try {
      currentUrl = await currentUrlPromise;
    } catch (error) {
      // If we can't get URL from fetch event, use a fallback or throw a better error
      throw new Error(
        `Failed to capture current URL from Service Worker fetch event: ${error instanceof Error ? error.message : String(error)}. ` +
        'Make sure the Service Worker is properly installed and activated.'
      );
    }

    await registerSubscription.registerPushSubscription(currentUrl, user);
  }
}

export type { User };
