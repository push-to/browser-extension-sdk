declare let self: ServiceWorkerGlobalScope;

import { ApiClient, PushToApiError } from './api-client';
import { SDK_VERSION } from './constants';
import { hasNotificationsPermission } from './notification-permission';
import {
  identifiedId,
  PushNotificationStorage,
} from './push-notification-storage';
import { clearDisplayedNotifications } from './receive-notification';
import {
  PushState,
  RegisterSubscriptionBody,
  RegistrationResult,
  SubscriptionJson,
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
  const id = identifiedId(user);
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

const REGISTER_FIRST =
  'Register this browser first: call identify() or reset() (subscribe() after an unsubscribe()), and wait for it to resolve with status "registered" or "unchanged".';

/** `undefined` for a subscription without an address or keys. */
function toSubscriptionJson(
  subscription: PushSubscription,
): SubscriptionJson | undefined {
  const { endpoint, expirationTime, keys } = subscription.toJSON();
  if (!endpoint || !keys?.p256dh || !keys?.auth) {
    return undefined;
  }
  return {
    endpoint,
    expirationTime: expirationTime ?? null,
    keys: { p256dh: keys.p256dh, auth: keys.auth },
  };
}

/**
 * The browser's push subscription, or `null`: also when it cannot be read,
 * which is what `pushManager` does without the `notifications` permission.
 */
async function currentSubscription(): Promise<PushSubscription | null> {
  if (typeof self === 'undefined' || !self.registration) {
    return null;
  }
  try {
    return await self.registration.pushManager.getSubscription();
  } catch {
    return null;
  }
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
   * Everything that reads or changes the registration runs in call order,
   * each after the one before it has settled; one that failed does not stop
   * the next.
   */
  private static enqueue<T>(task: () => Promise<T>): Promise<T> {
    const result = RegisterSubscription.queue.then(task, task);
    RegisterSubscription.queue = result.catch(() => undefined);
    return result;
  }

  /**
   * Registers this browser with push-api: one `POST /v1/subscriptions`, which
   * finds or creates the user and registers the push subscription for it.
   *
   * The call is skipped (`unchanged`) when nothing it would send has changed
   * since the last successful registration and that one is under 24 hours
   * old, so this is cheap to call on every service-worker start: no request
   * at all then.
   *
   * Without the `notifications` permission nothing is subscribed or sent
   * (`permission_required`); {@link registerRemembered} makes the
   * registration once the permission is there.
   *
   * After `unsubscribe()` nothing is subscribed or sent either
   * (`unsubscribed`): only {@link subscribe} ends an opt-out. This matters
   * because this call is meant to run on every service-worker start, where
   * it must not undo what the user asked for.
   *
   * In every case `user` is remembered as the identity asked for.
   */
  public registerPushSubscription(
    currentUrl: string,
    user?: User,
  ): Promise<RegistrationResult> {
    return RegisterSubscription.enqueue(async () => {
      await this.remember(user);
      if (await PushNotificationStorage.isOptedOut()) {
        return {
          status: 'unsubscribed',
          externalId: toUserBody(
            user,
            await PushNotificationStorage.getAnonymousId(),
          ).external_id,
        };
      }
      return this.register(currentUrl, user);
    });
  }

  /**
   * Ends an opt-out and registers with the identity last asked for (the
   * anonymous subscriber when none was). The only call that ends an opt-out.
   * On a browser that is not opted out it is a registration with the
   * remembered identity.
   */
  public subscribe(currentUrl: string): Promise<RegistrationResult> {
    return RegisterSubscription.enqueue(async () => {
      if (await PushNotificationStorage.isOptedOut()) {
        await PushNotificationStorage.setOptedOut(false);
      }
      const identity = await PushNotificationStorage.getIdentity();
      if (!identity) {
        await this.remember(undefined);
      }
      return this.register(currentUrl, identity?.user);
    });
  }

  /**
   * The automatic registration, made when the `notifications` permission is
   * granted: with the identity last asked for. Resolves to `undefined`
   * without doing anything when no registration was ever asked for, after
   * `unsubscribe()`, or when the identity was given with more than an id
   * (`hash`, `email`, …) and those are gone because the browser restarted:
   * the application's own call at startup supplies them again.
   */
  public registerRemembered(
    currentUrl: string,
  ): Promise<RegistrationResult | undefined> {
    return RegisterSubscription.enqueue(async () => {
      if (await PushNotificationStorage.isOptedOut()) {
        return undefined;
      }
      const identity = await PushNotificationStorage.getIdentity();
      if (!identity || identity.detailsLost) {
        return undefined;
      }
      return this.register(currentUrl, identity.user);
    });
  }

  /**
   * Forgets the cached registration, so that the next one is sent in full.
   * For when the `notifications` permission is removed: the subscription is
   * gone or useless then, and `pushManager` must not be touched.
   */
  public static forgetRegistration(): Promise<void> {
    return RegisterSubscription.enqueue(() =>
      PushNotificationStorage.clearRegistration(),
    );
  }

  /**
   * Stops push for this browser, in this order:
   *
   * 1. The opted-out flag is stored. From here on nothing registers until
   *    {@link subscribe}, and a push that still arrives is not displayed.
   * 2. The SDK's notifications on screen are taken away.
   * 3. The browser's subscription is removed. This is what stops delivery,
   *    so it does not wait for the network.
   * 4. push-api is told to disable the subscription, with the address and
   *    keys read before step 3 (they are what proves the address is this
   *    browser's). Best effort: a failure is logged, and push-api disables
   *    the endpoint by itself when the push service next reports it gone.
   * 5. The registration and VAPID caches are deleted. The remembered
   *    identity stays: it is what `subscribe()` registers.
   *
   * Rejects only when the browser itself could not remove the subscription.
   * When the subscription cannot be read at all (the `notifications`
   * permission is missing) steps 3 and 4 cannot happen; the flag of step 1
   * is then what keeps anything from being displayed.
   */
  public unsubscribe(): Promise<void> {
    return RegisterSubscription.enqueue(async () => {
      await PushNotificationStorage.setOptedOut(true);
      await clearDisplayedNotifications();
      try {
        const subscription = await currentSubscription();
        if (!subscription) {
          return;
        }
        const json = toSubscriptionJson(subscription);
        // A browser that refuses (`false`) or fails (throws) must not cost
        // the call to push-api, which stops the sending all the same.
        let removed = false;
        let failure: unknown;
        try {
          removed = (await subscription.unsubscribe()) !== false;
        } catch (error) {
          failure = error;
        }
        if (json) {
          try {
            await this.api.deleteSubscription({ subscription: json });
          } catch (error) {
            console.warn(
              '[PushTo] could not remove the subscription from the API; the API disables it by itself on its next send',
              error,
            );
          }
        }
        if (failure !== undefined) {
          throw failure;
        }
        if (!removed) {
          throw new Error(
            'PushNotifications: the browser did not remove the push subscription',
          );
        }
      } finally {
        await PushNotificationStorage.clearRegistrationAndVapidKey();
      }
    });
  }

  /**
   * Asks push-api to send its fixed test notification to this browser's
   * subscription. It arrives as a normal push.
   */
  public sendTestNotification(): Promise<{ notificationId: number }> {
    return RegisterSubscription.enqueue(async () => {
      const subscription = await currentSubscription();
      const json = subscription ? toSubscriptionJson(subscription) : undefined;
      if (!json) {
        // The SDK's own: there is nothing to ask push-api about.
        const reason = (await hasNotificationsPermission())
          ? `This browser has no push subscription. ${REGISTER_FIRST}`
          : 'The extension does not hold the `notifications` permission, so this browser has no push subscription. Ask for the permission first (requestNotificationPermission() in a page).';
        throw new PushToApiError({
          status: 0,
          code: 'subscription_not_found',
          message: reason,
        });
      }
      try {
        return await this.api.sendTestNotification({ subscription: json });
      } catch (error) {
        if (!(error instanceof PushToApiError)) {
          throw error;
        }
        const notFound = error.code === 'subscription_not_found';
        if (notFound || error.code === 'subscription_gone') {
          // push-api does not hold this subscription as active, whatever the
          // cache says: the next registration must be sent, not skipped.
          await PushNotificationStorage.clearRegistration().catch(
            () => undefined,
          );
        }
        if (notFound) {
          throw new PushToApiError({
            status: error.status,
            code: error.code,
            message: `${error.message}. ${REGISTER_FIRST}`,
            details: error.details,
          });
        }
        throw error;
      }
    });
  }

  /** What this browser knows about its registration. No request is made. */
  public async getState(): Promise<PushState> {
    const [granted, registration, identity, optedOut, anonymousId] =
      await Promise.all([
        hasNotificationsPermission(),
        PushNotificationStorage.getRegistration(),
        PushNotificationStorage.getIdentity(),
        PushNotificationStorage.isOptedOut(),
        PushNotificationStorage.getAnonymousId(),
      ]);
    // Without the permission pushManager only fails.
    const subscription = granted ? await currentSubscription() : null;

    const state: PushState = {
      permission: granted ? 'granted' : 'missing',
      subscribed: subscription !== null,
      registered: false,
      optedOut,
      anonymousId,
      apiBaseUrl: this.api.baseUrl,
      sdkVersion: SDK_VERSION,
    };

    if (
      subscription &&
      registration?.externalId !== undefined &&
      isFresh(registration.registeredAt, Date.now()) &&
      registration.endpointHash === (await sha256Hex(subscription.endpoint))
    ) {
      state.registered = true;
      state.externalId = registration.externalId;
      state.registeredAt = new Date(registration.registeredAt).toISOString();
      if (registration.userId !== undefined) {
        state.userId = registration.userId;
      }
      if (registration.endpointId !== undefined) {
        state.endpointId = registration.endpointId;
      }
    } else if (identity) {
      state.externalId = identity.id ?? `anon:${anonymousId}`;
    }
    // The very check the push handler makes.
    const blocked = await PushNotificationStorage.deliveryBlock();
    if (blocked) {
      state.deliveryBlocked = blocked;
    }
    return state;
  }

  /**
   * Stores what an explicit call asked for, and takes the notifications on
   * screen away when the identified user changes. Best effort: a storage
   * failure is logged and the call goes on. Nothing is written when nothing
   * changed, which is every service-worker start but the first.
   */
  private async remember(user?: User) {
    let previousId: string | undefined;
    try {
      previousId = (await PushNotificationStorage.replaceIdentity(user))?.id;
    } catch (error) {
      console.warn('[PushTo] could not store the identity asked for', error);
    }
    // Another person may be at this browser now: what was shown to the user
    // who was signed in is taken off the screen. Whether the registration
    // that follows succeeds does not matter for that.
    if (previousId !== undefined && previousId !== identifiedId(user)) {
      await clearDisplayedNotifications();
    }
  }

  private async register(
    currentUrl: string,
    user?: User,
  ): Promise<RegistrationResult> {
    // Check if Service Worker is available
    if (typeof self === 'undefined' || !self.registration) {
      throw new Error(
        'Service Worker registration is not available. Ensure this code is running in a Service Worker context and the Service Worker is properly registered.',
      );
    }
    const registration = self.registration;
    const anonymousId = await PushNotificationStorage.getAnonymousId();

    // pushManager fails at once without the permission, and there is no
    // prompt to wait for: the page has to ask for it.
    if (!(await hasNotificationsPermission())) {
      return {
        status: 'permission_required',
        externalId: toUserBody(user, anonymousId).external_id,
      };
    }

    const now = Date.now();
    const stored = await PushNotificationStorage.getRegistration();
    // An entry written by 1.0.0 has no external id (and no push-api ids to
    // answer with): it is not trusted, so one full registration replaces it.
    const previous =
      stored?.externalId !== undefined && isFresh(stored.registeredAt, now)
        ? stored
        : undefined;

    const existing = await registration.pushManager.getSubscription();

    // The stored VAPID key is good enough to confirm a subscription that is
    // already there and already registered. Anything else reads the key.
    let vapid = await this.resolveVapidKey(
      now,
      existing !== null && previous !== undefined,
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

    if (previous?.fingerprint === request.fingerprint) {
      const unchanged: RegistrationResult = {
        status: 'unchanged',
        externalId: request.body.external_id,
      };
      if (previous.userId !== undefined) {
        unchanged.userId = previous.userId;
      }
      if (previous.endpointId !== undefined) {
        unchanged.endpointId = previous.endpointId;
      }
      return unchanged;
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

    let ids: { userId?: number; endpointId?: number };
    try {
      ids = await this.api.registerSubscription(request.body);
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
      ids = await this.api.registerSubscription(request.body);
    }

    const externalId = request.body.external_id;
    // The API has now moved this browser away from another identified user.
    // Their notifications were cleared when the change was asked for; this
    // catches one that was already on its way to the screen then, and a
    // change that was asked for by an earlier call that failed.
    if (
      stored?.externalId !== undefined &&
      stored.externalId !== externalId &&
      stored.externalId !== `anon:${anonymousId}`
    ) {
      await clearDisplayedNotifications();
    }
    await PushNotificationStorage.setRegistration({
      fingerprint: request.fingerprint,
      registeredAt: now,
      ...ids,
      externalId,
      endpointHash: await sha256Hex(subscription.endpoint),
    });
    return { status: 'registered', ...ids, externalId };
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
    const subscription = toSubscriptionJson(pushSubscription);
    if (!subscription) {
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
      subscription,
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
