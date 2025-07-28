declare let self: ServiceWorkerGlobalScope;

import { CORE_URL } from './constants';
import { PushNotificationStorage } from './push-notification-storage';
import { User } from './types';

export class RegisterSubscription {
  private registerUrl: string = CORE_URL + '/subscriptions';
  private vapidKeysUrl: string = CORE_URL + '/vapid-keys';

  constructor(private readonly apiKey: string) {}

  public async registerPushSubscription(currentUrl: string, user?: User) {
    if (this.registerUrl === undefined) {
      throw new Error('registerUrl is not set');
    }

    const localRegistration = self.registration;

    const registration = localRegistration;
    const subscription = await this.subscribePush(registration);
    const anonymousId = await PushNotificationStorage.getAnonymousId();

    await fetch(this.registerUrl, {
      method: 'POST',
      body: JSON.stringify({
        anonymousId,
        browserLanguage: navigator.language,
        subscription,
        context: {
          url: currentUrl,
        },
        user,
      }),
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
    });
  }

  private async subscribePush(registration: ServiceWorkerRegistration) {
    const response = await fetch(this.vapidKeysUrl, {
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
    });
    const data = await response.json();

    const publicVapidKey = data.publicVapidKey;

    if (publicVapidKey === undefined) {
      throw new Error('PUBLIC_VAPID_KEY is not set');
    }

    const subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: this.urlBase64ToUint8Array(publicVapidKey),
    });

    return subscription;
  }

  private urlBase64ToUint8Array(b64: string) {
    const padding = '='.repeat((4 - (b64.length % 4)) % 4);
    const base64 = (b64 + padding).replace(/\-/g, '+').replace(/_/g, '/');

    const rawData = globalThis.atob(base64);
    const outputArray = new Uint8Array(rawData.length);

    for (let i = 0; i < rawData.length; ++i) {
      outputArray[i] = rawData.charCodeAt(i);
    }

    return outputArray;
  }
}
