declare let self: ServiceWorkerGlobalScope;

import { ApiClient, resolveApiBaseUrl } from './api-client';
import { PermissionWatcher } from './notification-permission';
import {
  PushState,
  PushSubscriptionOptions,
  RegistrationResult,
  User,
} from './types';
import { RegisterSubscription } from './register-subscription';
import { ReceiveNotification } from './receive-notification';

export class PushNotifications {
  private registration: RegisterSubscription;

  /**
   * Must run synchronously at the top level of the service worker. It adds
   * every listener the SDK needs and makes no request.
   *
   * It does not need the `notifications` permission: when that is an optional
   * permission that has not been granted, the `chrome.notifications`
   * listeners are left out and added as soon as the permission is there.
   * Throws only outside a service worker or for an invalid `apiBaseUrl`.
   */
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

    const api = new ApiClient(
      options.apiKey,
      resolveApiBaseUrl(options.apiBaseUrl),
    );
    this.registration = new RegisterSubscription(
      api,
      options.apiKey,
      options.vapidPublicKey,
    );

    ReceiveNotification.initialize(api, options);

    PermissionWatcher.initialize({
      added: () => {
        ReceiveNotification.attachNotificationListeners();
        // chrome.* events have no waitUntil: only make sure nothing is left
        // as an unhandled rejection. A registration that fails here is made
        // again by the next explicit call.
        this.registerRemembered().catch((error) =>
          console.warn(
            '[PushTo] could not register after the notifications permission was granted',
            error,
          ),
        );
      },
      removed: () => {
        RegisterSubscription.forgetRegistration().catch((error) =>
          console.warn('[PushTo] could not forget the registration', error),
        );
      },
    });
  }

  /**
   * Registers this browser for the signed-in user. Call it on sign-in and on
   * every service-worker start while the user is signed in; when nothing
   * changed in the last 24 hours it makes no request (`status: 'unchanged'`).
   *
   * push-api finds or creates the user with `external_id` = `user.id` and
   * makes this browser's push subscription active for that user only: it is
   * disabled for whichever user (anonymous or not) it was registered to
   * before.
   *
   * After `unsubscribe()` it registers nothing and resolves with
   * `status: 'unsubscribed'`; without the `notifications` permission, with
   * `status: 'permission_required'`. The identity is remembered either way.
   *
   * Rejects with a `TypeError` when `user.id` is missing or empty, and with a
   * `PushToApiError` when push-api refuses the call.
   */
  public async identify(user: User): Promise<RegistrationResult> {
    const id: unknown = user?.id;
    const valid =
      (typeof id === 'string' && id.trim() !== '') ||
      (typeof id === 'number' && Number.isFinite(id));
    if (!valid) {
      throw new TypeError(
        'PushNotifications.identify: `user.id` is required. Use reset() for a signed-out (anonymous) subscriber.',
      );
    }
    return this.register(user);
  }

  /**
   * Back to the anonymous subscriber of this browser. Call it on sign-out.
   *
   * The push subscription is registered under `anon:<anonymousId>` and
   * push-api disables it for the previous user, so that user's notifications
   * no longer reach this browser. What the SDK remembered about the previous
   * user (id, `hash`, …) is dropped, and its notifications still on screen
   * are taken away. The previous user's row stays on the server; deleting it
   * is a server-side call.
   */
  public reset(): Promise<RegistrationResult> {
    return this.register(undefined);
  }

  /**
   * Turns push notifications on for this browser: ends the opt-out left by
   * `unsubscribe()` and registers with the identity last given to
   * `identify` / `reset` (the anonymous subscriber if none was). It is the
   * only call that ends an opt-out; call it from your "turn notifications
   * on" control. Without an opt-out it registers the remembered identity.
   */
  public subscribe(): Promise<RegistrationResult> {
    return Promise.resolve().then(() =>
      this.registration.subscribe(this.getExtensionUrl()),
    );
  }

  /**
   * `identify(user)` when `user` has an `id`, `reset()` without a `user`.
   * Kept for source compatibility; prefer those two names. A `user` without
   * an `id` registers the anonymous subscriber with the other fields given.
   */
  public registerPushSubscription(user?: User): Promise<RegistrationResult> {
    return this.register(user);
  }

  /**
   * What this browser knows about its permission, subscription and
   * registration, read from the browser and `chrome.storage.local`. It makes
   * no request, so `registered` is what the SDK remembers, not what the
   * server holds.
   */
  public getState(): Promise<PushState> {
    return this.registration.getState();
  }

  /**
   * Stops push notifications for this browser until `subscribe()` is called.
   * The browser's subscription is removed, push-api is told to disable it,
   * the SDK's notifications on screen are taken away, and its registration
   * and VAPID caches are deleted. `identify` / `reset` keep working (they
   * remember the identity and resolve with `status: 'unsubscribed'`) but
   * register nothing, and a push that still arrives is not displayed.
   *
   * It works offline: a failed call to push-api is logged, not thrown,
   * because removing the browser's subscription is what stops delivery.
   * Rejects only if the browser could not remove the subscription.
   */
  public unsubscribe(): Promise<void> {
    return this.registration.unsubscribe();
  }

  /**
   * Asks push-api to send its fixed test notification to this browser. It
   * arrives through the normal push path and is displayed like any other.
   *
   * Rejects with a `PushToApiError`: `subscription_not_found` when this
   * browser is not registered (register first); `rate_limited` when a test
   * was sent to it less than 30 seconds ago (`details.scope` is `"address"`)
   * or the tenant's ceiling of test pushes is reached (`"tenant"`), with
   * `details.retry_after` in seconds. The request is not retried.
   */
  public sendTestNotification(): Promise<{ notificationId: number }> {
    return this.registration.sendTestNotification();
  }

  private async register(user?: User): Promise<RegistrationResult> {
    return this.registration.registerPushSubscription(
      this.getExtensionUrl(),
      user,
    );
  }

  private async registerRemembered() {
    return this.registration.registerRemembered(this.getExtensionUrl());
  }

  private getExtensionUrl(): string {
    try {
      return chrome.runtime.getURL('/');
    } catch (error) {
      throw new Error(
        `Failed to read the extension URL: ${error instanceof Error ? error.message : String(error)}. ` +
          'Make sure the Service Worker is properly installed and activated.',
      );
    }
  }
}
