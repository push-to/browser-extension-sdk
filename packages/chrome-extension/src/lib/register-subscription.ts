/// <reference types="chrome"/>
/// <reference lib="webworker" />
declare let self: ServiceWorkerGlobalScope;
import { CORE_URL, AUTH_TOKEN } from './constants';

export class RegisterSubscription {
  private registerUrl: string = CORE_URL + '/register-subscription';
  private authToken: string = AUTH_TOKEN;
  private vapidKeysUrl: string = CORE_URL + '/vapid-keys';

  constructor(private readonly apiKey: string) {}

  public async registerPushSubscription() {
    if (this.registerUrl === undefined) {
      throw new Error('registerUrl is not set');
    }

    const localRegistration = self.registration;

    const registration = localRegistration;
    const subscription = await this.subscribePush(registration);
    const anonymousId = await this.getOrCreateUserAnonymousId();

    console.info(`Sending push subscription to ${this.registerUrl}`);
    await fetch(this.registerUrl, {
      method: 'POST',
      body: JSON.stringify({
        anonymousId,
        browserLanguage: navigator.language,
        subscription,
      }),
      headers: {
        'Content-Type': 'application/json',
        Authorization: this.authToken,
        'x-pushto-api-key': this.apiKey,
      },
    });
    console.log('Push Sent!');
  }

  private async subscribePush(registration: ServiceWorkerRegistration) {
    const response = await fetch(this.vapidKeysUrl, {
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.authToken}`,
        'x-pushto-api-key': this.apiKey,
      },
    });
    const data = await response.json();
    console.log({ data });

    const publicVapidKey = data.publicVapidKey;

    if (publicVapidKey === undefined) {
      throw new Error('PUBLIC_VAPID_KEY is not set');
    }

    console.log('Registering Push...');
    const subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: this.urlBase64ToUint8Array(publicVapidKey),
    });
    console.log('Push Registered!');

    return subscription;
  }

  private async getOrCreateUserAnonymousId() {
    let { pt_anonymousId } = (await chrome.storage.local.get(
      'pt_anonymousId'
    )) as {
      pt_anonymousId: string;
    };
    console.info(`pt_anonymousId before: ${pt_anonymousId}`);
    if (pt_anonymousId === undefined) {
      pt_anonymousId = self.crypto.randomUUID();
      console.info(`pt_anonymousId after: ${pt_anonymousId}`);
      chrome.storage.local.set({ pt_anonymousId });
    }
    console.info(`pt_anonymousId returned: ${pt_anonymousId}`);
    return pt_anonymousId;
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
