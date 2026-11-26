declare let self: ServiceWorkerGlobalScope;

import { ApiClient, PushToApiError } from './api-client';
import { SDK_VERSION } from './constants';
import { PushNotificationStorage } from './push-notification-storage';
import {
  RegisterSubscriptionBody,
  SubscriptionUserFields,
  User,
} from './types';

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/**
 * The user part of the `POST /v1/subscriptions` body for a `User`.
 *
 * `external_id` is always sent, because push-api finds or creates the user by
 * it: an anonymous subscriber gets `anon:<anonymousId>`. A string `id` is sent
 * with its surrounding whitespace removed (`String.prototype.trim`) and
 * otherwise untouched; a finite number as its decimal string. push-api checks
 * `user_hash` against exactly that string. `user_hash` is sent
 * only next to an identified id: an anonymous id needs no proof. `name` is
 * split on its first run of whitespace. Absent and empty fields are left out
 * (push-api refuses `""`), and `properties` / `preferences` are never sent.
 */
export function toUserBody(
  user: User | undefined,
  anonymousId: string,
): SubscriptionUserFields {
  // A JS caller may pass a numeric id; that is still an identity.
  const rawId: unknown = user?.id;
  const id =
    typeof rawId === 'number' && Number.isFinite(rawId)
      ? String(rawId)
      : text(rawId);
  const body: SubscriptionUserFields = {
    external_id: id ?? `anon:${anonymousId}`,
  };

  const hash = id === undefined ? undefined : text(user?.hash);
  if (hash) {
    body.user_hash = hash;
  }

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

function isEndpointConflict(error: unknown) {
  return (
    error instanceof PushToApiError &&
    error.status === 409 &&
    error.code === 'endpoint_conflict'
  );
}

export class RegisterSubscription {
  /** Per worker: the warning for a `hash` without an `id` is logged once. */
  private static warnedHashWithoutId = false;

  // One registration at a time: two that overlap (anonymous at startup, then
  // identified) could finish out of order and leave the fingerprint of the
  // earlier one, and the next call would be skipped for 24 hours. Static
  // because `PushNotifications` makes a new instance for every call.
  private static queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly api: ApiClient,
    private readonly apiKey: string,
    private readonly vapidPublicKey?: string,
  ) {}

  /**
   * Registers this browser with push-api: one `POST /v1/subscriptions`, which
   * finds or creates the user and registers the push subscription for it.
   *
   * The call is skipped when nothing it would send has changed since the last
   * successful registration and that one is under 24 hours old, so this is
   * cheap to call on every service-worker start: no request at all then.
   *
   * Calls run in the order they were made, each after the one before it has
   * settled; a call that failed does not stop the next.
   */
  public registerPushSubscription(
    currentUrl: string,
    user?: User,
  ): Promise<void> {
    const task = () => this.register(currentUrl, user);
    const result = RegisterSubscription.queue.then(task, task);
    RegisterSubscription.queue = result.catch(() => undefined);
    return result;
  }

  private async register(currentUrl: string, user?: User) {
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
    let request = await this.buildRequest(
      subscription,
      currentUrl,
      anonymousId,
      user,
    );

    if (registrationIsFresh && previous.fingerprint === request.fingerprint) {
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
        request = await this.buildRequest(
          subscription,
          currentUrl,
          anonymousId,
          user,
        );
      }
    }

    try {
      await this.api.registerSubscription(request.body);
    } catch (error) {
      if (!isEndpointConflict(error)) {
        throw error;
      }
      // push-api holds this address with other keys, for this user or for
      // another one, which this browser's own registrations cannot cause.
      // The address is unusable here, so it is replaced, once: a second
      // refusal (of any kind) is the caller's.
      const refusedEndpoint = subscription.endpoint;
      await subscription.unsubscribe();
      subscription = await this.subscribePush(registration, null, vapid.key);
      if (subscription.endpoint === refusedEndpoint) {
        throw error;
      }
      request = await this.buildRequest(
        subscription,
        currentUrl,
        anonymousId,
        user,
      );
      await this.api.registerSubscription(request.body);
    }
    await PushNotificationStorage.setRegistration({
      fingerprint: request.fingerprint,
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

  private async buildRequest(
    pushSubscription: PushSubscription,
    currentUrl: string,
    anonymousId: string,
    user?: User,
  ) {
    const { endpoint, expirationTime, keys } = pushSubscription.toJSON();
    if (!endpoint || !keys?.p256dh || !keys?.auth) {
      throw new Error('The push subscription has no endpoint or keys');
    }

    const userFields = toUserBody(user, anonymousId);
    if (
      text(user?.hash) &&
      !userFields.user_hash &&
      !RegisterSubscription.warnedHashWithoutId
    ) {
      RegisterSubscription.warnedHashWithoutId = true;
      // The value itself is never logged.
      console.warn(
        'PushNotifications: `hash` was passed without an `id` and is not sent. An anonymous subscriber needs no hash; pass the `id` the hash was computed for.',
      );
    }

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

    const body: RegisterSubscriptionBody = {
      ...userFields,
      subscription: {
        endpoint,
        expirationTime: expirationTime ?? null,
        keys: { p256dh: keys.p256dh, auth: keys.auth },
      },
      metadata,
    };

    // The key is part of it because another key can be another tenant, and
    // `user_hash` because a new proof has to be presented. Only the hash of
    // all of it is stored.
    const fingerprint = await sha256Hex(
      JSON.stringify([this.api.baseUrl, this.apiKey, body]),
    );
    return { body, fingerprint };
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
