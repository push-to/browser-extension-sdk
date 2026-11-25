declare let self: ServiceWorkerGlobalScope;

import { ApiClient, resolveApiBaseUrl } from './api-client';
import { PushSubscriptionOptions, User } from './types';
import { RegisterSubscription } from './register-subscription';
import { ReceiveNotification } from './receive-notification';

export class PushNotifications {
  private apiKey: string;
  private api: ApiClient;
  private vapidPublicKey?: string;

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
    this.api = new ApiClient(
      options.apiKey,
      resolveApiBaseUrl(options.apiBaseUrl),
    );
    this.vapidPublicKey = options.vapidPublicKey;

    ReceiveNotification.initialize(this.api, options);
  }

  public async registerPushSubscription(user?: User) {
    const registerSubscription = new RegisterSubscription(
      this.api,
      this.apiKey,
      this.vapidPublicKey,
    );

    let currentUrl: string;
    try {
      currentUrl = this.getExtensionUrl();
    } catch (error) {
      throw new Error(
        `Failed to read the extension URL: ${error instanceof Error ? error.message : String(error)}. ` +
          'Make sure the Service Worker is properly installed and activated.',
      );
    }

    await registerSubscription.registerPushSubscription(currentUrl, user);
  }

  private getExtensionUrl(path: string = '/') {
    return chrome.runtime.getURL(path);
  }
}
