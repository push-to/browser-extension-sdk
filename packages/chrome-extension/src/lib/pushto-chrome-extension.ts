declare let self: ServiceWorkerGlobalScope;

import { PushSubscriptionOptions, User } from './types';
import { RegisterSubscription } from './register-subscription';
import { ReceiveNotification } from './receive-notification';

export class PushNotifications {
  private apiKey: string;

  constructor(options: PushSubscriptionOptions) {
    // Verify Service Worker context
    if (
      typeof self === 'undefined' ||
      !('ServiceWorkerGlobalScope' in globalThis)
    ) {
      throw new Error(
        "PushNotifications must be initialized in a Service Worker context. Ensure this code is running in your extension's service worker file.",
      );
    }

    this.apiKey = options.apiKey;

    ReceiveNotification.initialize(this.apiKey, options);
  }

  public async registerPushSubscription(user?: User) {
    const registerSubscription = new RegisterSubscription(this.apiKey);

    let currentUrl: string;
    try {
      currentUrl = this.getExtensionUrl();
    } catch (error) {
      // If we can't get URL from fetch event, use a fallback or throw a better error
      throw new Error(
        `Failed to capture current URL from Service Worker fetch event: ${error instanceof Error ? error.message : String(error)}. ` +
          'Make sure the Service Worker is properly installed and activated.',
      );
    }

    await registerSubscription.registerPushSubscription(currentUrl, user);
  }

  private getExtensionUrl(path: string = '/') {
    return chrome.runtime.getURL(path);
  }
}

export type { User };
