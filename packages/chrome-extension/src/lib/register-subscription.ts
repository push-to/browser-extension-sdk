declare let self: ServiceWorkerGlobalScope;

import { ApiClient } from './api-client';
import { SDK_VERSION } from './constants';
import { PushNotificationStorage } from './push-notification-storage';
import { RegisterEndpointBody, UpsertUserBody, User } from './types';

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/**
 * The `POST /v1/users` body for a `User`.
 *
 * `external_id` is always sent, because without one push-api inserts a new
 * user on every call: an anonymous subscriber gets `anon:<anonymousId>`.
 * `name` is split on its first run of whitespace. Absent and empty fields are
 * left out (push-api refuses `""`), and `properties` / `preferences` are
 * never sent: push-api replaces them wholesale.
 */
export function toUserBody(
  user: User | undefined,
  anonymousId: string,
): UpsertUserBody {
  // A JS caller may pass a numeric id; that is still an identity.
  const rawId: unknown = user?.id;
  const id =
    typeof rawId === 'number' && Number.isFinite(rawId)
      ? String(rawId)
      : text(rawId);
  const body: UpsertUserBody = {
    external_id: id ?? `anon:${anonymousId}`,
  };

  const email = text(user?.email);
  if (email) {
    body.email = email;
  }

  const name = text(user?.name);
  if (name) {
    const [, firstName, lastName] = /^(\S+)\s*([\s\S]*)$/.exec(name) ?? [];
    if (firstName) {
      body.first_name = firstName;
    }
    if (lastName) {
      body.last_name = lastName;
    }
  }

  return body;
}

export function urlBase64ToUint8Array(b64: string) {
  const padding = '='.repeat((4 - (b64.length % 4)) % 4);
  const base64 = (b64 + padding).replace(/-/g, '+').replace(/_/g, '/');

  let rawData: string;
  try {
    rawData = globalThis.atob(base64);
  } catch {
    throw new Error('The VAPID public key is not valid base64url');
  }
  const outputArray = new Uint8Array(rawData.length);

  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i);
  }

  return outputArray;
}

function sameBytes(a: Uint8Array, b: Uint8Array) {
  return a.length === b.length && a.every((byte, i) => byte === b[i]);
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
}

/**
 * How long a registration, and the VAPID key read from the API, are trusted.
 * After that both are sent / read again even if nothing changed locally, so a
 * device recovers within a day from what it cannot see: an endpoint push-api
 * disabled, a user row removed, a rotated VAPID key.
 */
export const REGISTRATION_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** A stored time in the future (the clock was set back) is not fresh. */
function isFresh(timestamp: number, now: number) {
  const age = now - timestamp;
  return age >= 0 && age < REGISTRATION_MAX_AGE_MS;
}

export class RegisterSubscription {
  constructor(
    private readonly api: ApiClient,
    private readonly apiKey: string,
    private readonly vapidPublicKey?: string,
  ) {}

  /**
   * Registers this browser with push-api: `POST /v1/users`, then
   * `POST /v1/users/{id}/endpoints`.
   *
   * Both calls are skipped when nothing they would send has changed since the
   * last successful registration and that one is under 24 hours old, so this
   * is cheap to call on every service-worker start: no request at all then.
   */
  public async registerPushSubscription(currentUrl: string, user?: User) {
    // Check if Service Worker is available
    if (typeof self === 'undefined' || !self.registration) {
      throw new Error(
        'Service Worker registration is not available. Ensure this code is running in a Service Worker context and the Service Worker is properly registered.',
      );
    }
    const registration = self.registration;

    const now = Date.now();
    const previous = await PushNotificationStorage.getRegistration();
    const registrationIsFresh =
      previous !== undefined && isFresh(previous.registeredAt, now);

    const existing = await registration.pushManager.getSubscription();
    const anonymousId = await PushNotificationStorage.getAnonymousId();

    // The stored VAPID key is good enough to confirm a subscription that is
    // already there and already registered. Anything else reads the key.
    let vapid = await this.resolveVapidKey(
      now,
      existing !== null && registrationIsFresh,
    );
    let subscription = await this.subscribePush(
      registration,
      existing,
      vapid.key,
    );
    let bodies = await this.buildBodies(
      subscription,
      currentUrl,
      anonymousId,
      user,
    );

    if (registrationIsFresh && previous.fingerprint === bodies.fingerprint) {
      return;
    }

    // A full registration never goes out on a stored key.
    if (vapid.fromCache) {
      const cachedKey = vapid.key;
      vapid = await this.resolveVapidKey(now, false);
      if (vapid.key !== cachedKey) {
        subscription = await this.subscribePush(
          registration,
          subscription,
          vapid.key,
        );
        bodies = await this.buildBodies(
          subscription,
          currentUrl,
          anonymousId,
          user,
        );
      }
    }

    const userId = await this.api.upsertUser(bodies.user);
    await this.api.registerEndpoint(userId, bodies.endpoint);
    await PushNotificationStorage.setRegistration({
      fingerprint: bodies.fingerprint,
      registeredAt: now,
    });
  }

  private async resolveVapidKey(
    now: number,
    allowCached: boolean,
  ): Promise<{ key: string; fromCache: boolean }> {
    const configured = this.vapidPublicKey?.trim();
    if (configured) {
      return { key: configured, fromCache: false };
    }

    if (allowCached) {
      const cached = await PushNotificationStorage.getVapidKey();
      if (
        cached &&
        cached.baseUrl === this.api.baseUrl &&
        isFresh(cached.fetchedAt, now)
      ) {
        return { key: cached.publicKey, fromCache: true };
      }
    }

    const key = await this.api.getVapidPublicKey();
    await PushNotificationStorage.setVapidKey({
      publicKey: key,
      baseUrl: this.api.baseUrl,
      fetchedAt: now,
    });
    return { key, fromCache: false };
  }

  private async buildBodies(
    pushSubscription: PushSubscription,
    currentUrl: string,
    anonymousId: string,
    user?: User,
  ) {
    const { endpoint, keys } = pushSubscription.toJSON();
    if (!endpoint || !keys?.p256dh || !keys?.auth) {
      throw new Error('The push subscription has no endpoint or keys');
    }

    const userBody = toUserBody(user, anonymousId);

    const metadata: Record<string, string> = {
      channel: 'extension',
      extension_id: chrome.runtime.id,
      context_url: currentUrl,
      sdk_version: SDK_VERSION,
      anonymous_id: anonymousId,
    };
    const optionalMetadata = {
      browser_language:
        typeof navigator === 'undefined' ? undefined : text(navigator.language),
      image_url: text(user?.imageUrl),
      language: text(user?.language),
    };
    for (const [key, value] of Object.entries(optionalMetadata)) {
      if (value) {
        metadata[key] = value;
      }
    }

    const endpointBody: RegisterEndpointBody = {
      endpoint,
      keys: { p256dh: keys.p256dh, auth: keys.auth },
      metadata,
    };

    // The key is part of it because another key can be another tenant. Only
    // the hash is stored.
    const fingerprint = await sha256Hex(
      JSON.stringify([this.api.baseUrl, this.apiKey, userBody, endpointBody]),
    );
    return { user: userBody, endpoint: endpointBody, fingerprint };
  }

  /**
   * Returns the browser's subscription for the server's VAPID key, reusing
   * `existing`. A subscription made for another key cannot receive this
   * server's pushes, so it is replaced.
   */
  private async subscribePush(
    registration: ServiceWorkerRegistration,
    existing: PushSubscription | null,
    vapidPublicKey: string,
  ): Promise<PushSubscription> {
    const serverKey = urlBase64ToUint8Array(vapidPublicKey);
    const subscribe = () =>
      registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: serverKey,
      });

    if (!existing) {
      return subscribe();
    }

    const existingKey = existing.options?.applicationServerKey;
    if (existingKey) {
      if (sameBytes(new Uint8Array(existingKey), serverKey)) {
        return existing;
      }
      await existing.unsubscribe();
      return subscribe();
    }

    // The browser does not say which key the subscription was made for.
    // subscribe() returns it if the key matches and rejects with
    // InvalidStateError if it does not. Any other failure (permission, push
    // service unreachable) says nothing about the key, and must not cost a
    // working subscription.
    try {
      return await subscribe();
    } catch (error) {
      if ((error as { name?: unknown } | null)?.name !== 'InvalidStateError') {
        throw error;
      }
      await existing.unsubscribe();
      return subscribe();
    }
  }
}
