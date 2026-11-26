/**
 * Mocked MV3 service-worker environment shared by the tests: `chrome.*`,
 * `self` (push listeners + pushManager), `fetch` (a fake push-api) and
 * `navigator`. Nothing here touches the network.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { ApiClient } from '../api-client';
import { Dismiss } from '../dismiss';
import { PermissionWatcher } from '../notification-permission';
import { NotificationsState } from '../notifications-state';
import { PushNotificationEvents } from '../push-notification-events';
import { PushNotificationStorage } from '../push-notification-storage';
import { ReceiveNotification } from '../receive-notification';
import { RegisterSubscription } from '../register-subscription';

type Listener = (...args: any[]) => any;

function makeEvent() {
  const listeners: Listener[] = [];
  return { addListener: (fn: Listener) => listeners.push(fn), listeners };
}

export interface FetchCall {
  url: string;
  path: string;
  method: string;
  headers: Record<string, string>;
  body: any;
  keepalive: boolean;
  signal?: AbortSignal;
}

export const API_BASE_URL = 'https://api.test';

export function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** `user_hash` as the integrator's server computes it. */
export async function userHash(secret: string, externalId: string) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = await crypto.subtle.sign('HMAC', key, encoder.encode(externalId));
  return Array.from(new Uint8Array(mac), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
}

export const IDENTITY_SECRET = 'example-secret';

const SDK_ANONYMOUS_ID =
  /^anon:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function base64Url(bytes: Uint8Array) {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/** A well-formed (65-byte, uncompressed-point) VAPID public key. */
export function vapidKey(fill: number) {
  const bytes = new Uint8Array(65).fill(fill);
  bytes[0] = 4;
  return base64Url(bytes);
}

export function installMocks() {
  const env = {
    storage: {} as Record<string, any>,
    /** `chrome.storage.session`: survives a worker restart, not a browser restart. */
    session: {} as Record<string, any>,
    runtimeOnMessage: makeEvent(),
    /** Every `chrome.runtime.sendMessage` call. */
    sentMessages: [] as any[],
    /** What `sendMessage` does when no listener exists: Chrome rejects. */
    deliverMessages: true,
    alarms: new Map<string, { delayInMinutes: number }>(),
    /** Notifications on screen, with the options they were created with. */
    active: new Map<string, any>(),
    createCalls: [] as { id: string; options: any }[],
    /** Return a message to make `chrome.notifications.create` fail. */
    createError: (_options: any): string | undefined => undefined,
    /** Set to make every `chrome.storage.local.set` reject. */
    storageSetError: undefined as string | undefined,
    /** Set to false to model a worker that dies before clear()'s onClosed. */
    clearFiresOnClosed: true,
    fetchCalls: [] as FetchCall[],
    /**
     * Answer a call before the fake push-api does. Return `undefined` to let
     * it through; throw to simulate a network error.
     */
    intercept: undefined as
      | undefined
      | ((
          call: FetchCall,
        ) => Response | undefined | Promise<Response | undefined>),
    serverVapidKey: vapidKey(1),
    /** The tenant's identity secret; `undefined` is "none was ever issued". */
    identitySecret: IDENTITY_SECRET as string | undefined,
    /** The tenant's `required` switch. */
    identityRequired: false,
    /** False models a deployment without `PUSH_API_SIGNING_KEY`. */
    signingKeyConfigured: true,
    userId: 42,
    badgeTextCalls: [] as string[],
    badgeColorCalls: [] as string[],
    tabsCreateCalls: [] as { url: string }[],
    tabsCreateError: undefined as string | undefined,
    manifest: { icons: undefined } as { icons?: Record<string, string> },
    subscription: null as any,
    subscribeCalls: [] as any[],
    unsubscribeCalls: 0,
    notificationsOnClicked: makeEvent(),
    notificationsOnClosed: makeEvent(),
    alarmsOnAlarm: makeEvent(),
    actionOnClicked: makeEvent(),
    permissionsOnAdded: makeEvent(),
    permissionsOnRemoved: makeEvent(),
    pushListeners: [] as Listener[],
    /** Whether the extension holds the `notifications` permission. */
    notificationsGranted: true,
    /** What the user answers to `chrome.permissions.request`. */
    permissionRequestAnswer: true,
    permissionRequestCalls: [] as any[],
    /** Every `pushManager.getSubscription` / `subscribe` call. */
    pushManagerCalls: 0,
    /** Address → `p256dh` of the subscriptions the fake push-api holds active. */
    activeEndpoints: new Map<string, string>(),
    testNotificationId: 9001,

    /**
     * `notifications` is an optional permission that is not granted:
     * `chrome.notifications` is undefined and `pushManager` fails at once.
     */
    withoutNotificationsPermission() {
      env.notificationsGranted = false;
      delete (globalThis as any).chrome.notifications;
    },
    /**
     * The user grants it. `exposeApi: false` models a worker in which
     * `chrome.notifications` does not appear until it restarts;
     * `fireEvent: false` one that gets no `permissions.onAdded`.
     */
    grantNotifications(
      options: { exposeApi?: boolean; fireEvent?: boolean } = {},
    ) {
      env.notificationsGranted = true;
      if (options.exposeApi !== false) {
        (globalThis as any).chrome.notifications = notificationsApi;
      }
      if (options.fireEvent !== false) {
        env.permissionsOnAdded.listeners.forEach((l) =>
          l({ permissions: ['notifications'], origins: [] }),
        );
      }
    },
    removeNotificationsPermission() {
      env.withoutNotificationsPermission();
      env.permissionsOnRemoved.listeners.forEach((l) =>
        l({ permissions: ['notifications'], origins: [] }),
      );
    },

    feedback() {
      return env.fetchCalls.filter((c) => c.path === '/v1/feedback');
    },
    feedbackTypes(notificationId: number) {
      return env
        .feedback()
        .filter((c) => c.body?.notification_id === notificationId)
        .map((c) => c.body?.event_type as string);
    },
    /** Dispatches a push and waits for everything handed to `waitUntil`. */
    async push(payload: unknown, json?: () => unknown) {
      const waits: Promise<unknown>[] = [];
      const event = {
        data: payload === null ? null : { json: json ?? (() => payload) },
        waitUntil: (p: Promise<unknown>) => waits.push(p),
      };
      for (const listener of env.pushListeners) {
        listener(event);
      }
      await Promise.all(waits);
      return waits.length;
    },
    click(id: string) {
      env.notificationsOnClicked.listeners.forEach((l) => l(id));
    },
    /** The system closes it: onClosed with `byUser` false, no clear(). */
    systemClose(id: string) {
      env.active.delete(id);
      env.notificationsOnClosed.listeners.forEach((l) => l(id, false));
    },
    /**
     * The worker is terminated and a new one starts: no singleton, no
     * listener and nothing in memory survives; only the browser's state
     * (storage, alarms, notifications on screen) does. Call the SDK's
     * top-level init afterwards.
     */
    restartWorker() {
      resetSingletons();
      for (const listeners of [
        env.pushListeners,
        env.notificationsOnClicked.listeners,
        env.notificationsOnClosed.listeners,
        env.alarmsOnAlarm.listeners,
        env.actionOnClicked.listeners,
        env.permissionsOnAdded.listeners,
        env.permissionsOnRemoved.listeners,
        env.runtimeOnMessage.listeners,
      ]) {
        listeners.length = 0;
      }
    },
    /** The browser is closed and opened again: session storage is gone too. */
    restartBrowser() {
      env.restartWorker();
      for (const key of Object.keys(env.session)) {
        delete env.session[key];
      }
    },
    /**
     * A message as `chrome.runtime.onMessage` dispatches it. Resolves to
     * what each listener returned, and whether any called `sendResponse`.
     */
    dispatchMessage(
      message: unknown,
      /** `null`: a sender without an id. */
      senderId: string | null = 'ext-test-id',
    ) {
      let responded = false;
      const returned = env.runtimeOnMessage.listeners.map((l) =>
        l(message, senderId === null ? {} : { id: senderId }, () => {
          responded = true;
        }),
      );
      return { returned, responded };
    },
    /** The user closes a notification: onClosed with no clear() before it. */
    userClose(id: string) {
      env.active.delete(id);
      env.notificationsOnClosed.listeners.forEach((l) => l(id, true));
    },
    fireAlarm(name: string) {
      env.alarmsOnAlarm.listeners.forEach((l) => l({ name }));
    },
  };

  let subscriptionCounter = 0;
  const registered = new Set<string>();
  const sameKey = (a: ArrayBuffer, b: Uint8Array) =>
    base64Url(new Uint8Array(a)) === base64Url(b);

  /** push-api's identity check on `POST /v1/subscriptions`. */
  const checkProof = async (body: any) => {
    const hash = body?.user_hash;
    const externalId = String(body?.external_id);
    if (hash !== undefined && typeof hash !== 'string') {
      return jsonResponse(422, {
        error: {
          code: 'validation_error',
          message: 'user_hash must be a string',
        },
      });
    }
    const needsProof =
      env.identityRequired && !SDK_ANONYMOUS_ID.test(externalId);
    if (
      !env.signingKeyConfigured &&
      (needsProof || (hash !== undefined && env.identitySecret !== undefined))
    ) {
      return jsonResponse(503, {
        error: {
          code: 'identity_verification_unavailable',
          message:
            'identity verification is not configured on this deployment: PUSH_API_SIGNING_KEY is not set',
        },
      });
    }
    if (hash !== undefined) {
      // The HMAC is over `external_id` exactly as received: no trim, no case
      // fold. The hash's own hex digits compare case-insensitively, as on
      // push-api.
      const valid =
        env.identitySecret !== undefined &&
        hash.toLowerCase() === (await userHash(env.identitySecret, externalId));
      return valid
        ? undefined
        : jsonResponse(403, {
            error: {
              code: 'invalid_user_hash',
              message: 'user_hash is not valid for this external_id',
            },
          });
    }
    return needsProof
      ? jsonResponse(403, {
          error: {
            code: 'user_hash_required',
            message:
              'this tenant requires identity verification: send the user_hash for this external_id',
          },
        })
      : undefined;
  };

  (globalThis as any).fetch = async (url: string, init: any = {}) => {
    const call: FetchCall = {
      url,
      path: new URL(url).pathname,
      method: init.method ?? 'GET',
      headers: init.headers ?? {},
      body: init.body ? JSON.parse(init.body) : undefined,
      keepalive: init.keepalive === true,
      signal: init.signal,
    };
    env.fetchCalls.push(call);

    const intercepted = await env.intercept?.(call);
    if (intercepted) {
      return intercepted;
    }
    if (call.method === 'GET' && call.path === '/v1/vapid-key') {
      return jsonResponse(200, { public_key: env.serverVapidKey });
    }
    if (call.method === 'POST' && call.path === '/v1/subscriptions') {
      const refused = await checkProof(call.body);
      if (refused) {
        return refused;
      }
      // 201 for a new address of this user, 200 for one it already had.
      const key = `${call.body?.external_id} ${call.body?.subscription?.endpoint}`;
      const status = registered.has(key) ? 200 : 201;
      registered.add(key);
      env.activeEndpoints.set(
        call.body?.subscription?.endpoint,
        call.body?.subscription?.keys?.p256dh,
      );
      return jsonResponse(status, { user_id: env.userId, endpoint_id: 7 });
    }
    // Both act only on a row whose stored keys equal the ones presented.
    const presented = call.body?.subscription;
    const holdsIt =
      presented?.endpoint !== undefined &&
      env.activeEndpoints.get(presented.endpoint) === presented.keys?.p256dh;
    if (call.method === 'DELETE' && call.path === '/v1/subscriptions') {
      if (holdsIt) {
        env.activeEndpoints.delete(presented.endpoint);
      }
      return new Response(null, { status: 204 });
    }
    if (call.method === 'POST' && call.path === '/v1/subscriptions/test') {
      return holdsIt
        ? jsonResponse(200, {
            sent: true,
            notification_id: env.testNotificationId,
          })
        : jsonResponse(404, {
            error: {
              code: 'subscription_not_found',
              message: 'no active subscription with these keys',
            },
          });
    }
    // A browser key no longer reaches the id-based routes.
    if (call.method === 'POST' && /^\/v1\/users(\/|$)/.test(call.path)) {
      return jsonResponse(403, {
        error: {
          code: 'insufficient_permissions',
          message: 'this API key cannot call this route',
        },
      });
    }
    if (call.method === 'POST' && call.path === '/v1/feedback') {
      return jsonResponse(202, { accepted: true });
    }
    return jsonResponse(404, {
      error: { code: 'not_found', message: 'no such route' },
    });
  };

  const notificationsApi: any = {
    create: (id: string, options: any, callback?: (id: string) => void) => {
      env.createCalls.push({ id, options });
      const error = env.createError(options);
      if (error) {
        chromeMock.runtime.lastError = { message: error };
      } else {
        env.active.set(id, options);
      }
      callback?.(id);
      chromeMock.runtime.lastError = undefined;
    },
    clear: (id: string, callback?: (wasCleared: boolean) => void) => {
      const wasCleared = env.active.delete(id);
      callback?.(wasCleared);
      // Real chrome.notifications.clear() asynchronously fires onClosed —
      // model that cascade so read-before-clear ordering bugs are actually
      // exercised (see "Click path ordering").
      if (wasCleared && env.clearFiresOnClosed) {
        queueMicrotask(() =>
          env.notificationsOnClosed.listeners.forEach((l) => l(id, false)),
        );
      }
    },
    getAll: (cb: (obj: Record<string, unknown>) => void) => {
      const obj: Record<string, unknown> = {};
      for (const id of env.active.keys()) obj[id] = {};
      cb(obj);
    },
    onClicked: env.notificationsOnClicked,
    onClosed: env.notificationsOnClosed,
  };

  const chromeMock: any = {
    storage: {
      local: {
        get: async (key: string) => ({ [key]: env.storage[key] }),
        remove: async (keys: string | string[]) => {
          if (env.storageSetError) {
            throw new Error(env.storageSetError);
          }
          for (const key of [keys].flat()) {
            delete env.storage[key];
          }
        },
        set: async (obj: Record<string, any>) => {
          if (env.storageSetError) {
            throw new Error(env.storageSetError);
          }
          // chrome.storage round-trips values through JSON.
          Object.assign(env.storage, JSON.parse(JSON.stringify(obj)));
        },
      },
      session: {
        get: async (key: string) => ({ [key]: env.session[key] }),
        set: async (obj: Record<string, any>) => {
          Object.assign(env.session, JSON.parse(JSON.stringify(obj)));
        },
        remove: async (keys: string | string[]) => {
          for (const key of [keys].flat()) {
            delete env.session[key];
          }
        },
      },
    },
    alarms: {
      create: async (name: string, info: { delayInMinutes: number }) => {
        env.alarms.set(name, info);
      },
      clear: async (name: string) => env.alarms.delete(name),
      onAlarm: env.alarmsOnAlarm,
    },
    notifications: undefined as any,
    action: {
      setBadgeText: async (opts: { text: string }) => {
        env.badgeTextCalls.push(opts.text);
      },
      setBadgeBackgroundColor: async (opts: { color: string }) => {
        env.badgeColorCalls.push(opts.color);
      },
      onClicked: env.actionOnClicked,
    },
    tabs: {
      create: async (opts: { url: string }) => {
        if (env.tabsCreateError) {
          throw new Error(env.tabsCreateError);
        }
        env.tabsCreateCalls.push(opts);
        return { id: 1 };
      },
    },
    permissions: {
      contains: async (query: { permissions?: string[] }) =>
        (query.permissions ?? []).every(
          (name) => name !== 'notifications' || env.notificationsGranted,
        ),
      request: (query: any) => {
        env.permissionRequestCalls.push(query);
        return Promise.resolve(env.permissionRequestAnswer);
      },
      onAdded: env.permissionsOnAdded,
      onRemoved: env.permissionsOnRemoved,
    },
    runtime: {
      id: 'ext-test-id',
      lastError: undefined,
      getURL: (p: string) =>
        `chrome-extension://ext-test-id/${p.replace(/^\//, '')}`,
      getManifest: () => env.manifest,
      onMessage: env.runtimeOnMessage,
      sendMessage: (message: unknown) => {
        env.sentMessages.push(message);
        if (
          !env.deliverMessages ||
          env.runtimeOnMessage.listeners.length === 0
        ) {
          return Promise.reject(
            new Error(
              'Could not establish connection. Receiving end does not exist.',
            ),
          );
        }
        env.dispatchMessage(message);
        return Promise.resolve(undefined);
      },
    },
  };
  chromeMock.notifications = notificationsApi;
  (globalThis as any).chrome = chromeMock;

  // Chrome documents "an immediate error" and no more; the name is a guess.
  const failWithoutPermission = () => {
    env.pushManagerCalls++;
    if (!env.notificationsGranted) {
      throw new DOMException('permission denied', 'NotAllowedError');
    }
  };

  (globalThis as any).self = {
    addEventListener: (type: string, fn: Listener) => {
      if (type === 'push') env.pushListeners.push(fn);
    },
    removeEventListener: (type: string, fn: Listener) => {
      const index = env.pushListeners.indexOf(fn);
      if (type === 'push' && index >= 0) env.pushListeners.splice(index, 1);
    },
    registration: {
      pushManager: {
        getSubscription: async () => {
          failWithoutPermission();
          return env.subscription;
        },
        subscribe: async (options: any) => {
          failWithoutPermission();
          env.subscribeCalls.push(options);
          const key = new Uint8Array(options.applicationServerKey);
          if (env.subscription) {
            if (sameKey(env.subscription.options.applicationServerKey, key)) {
              return env.subscription;
            }
            throw new DOMException(
              'another applicationServerKey',
              'InvalidStateError',
            );
          }
          const n = ++subscriptionCounter;
          const endpoint = `https://fcm.googleapis.com/fcm/send/sub-${n}`;
          env.subscription = {
            endpoint,
            options: { applicationServerKey: key.buffer },
            toJSON: () => ({
              endpoint,
              expirationTime: null,
              keys: { p256dh: `p256dh-${n}`, auth: `auth-${n}` },
            }),
            unsubscribe: async () => {
              env.unsubscribeCalls++;
              env.subscription = null;
              return true;
            },
          };
          return env.subscription;
        },
      },
    },
  };
  (globalThis as any).ServiceWorkerGlobalScope = class {};
  Object.defineProperty(globalThis, 'navigator', {
    value: { language: 'pt-BR' },
    configurable: true,
    writable: true,
  });

  return env;
}

export type TestEnv = ReturnType<typeof installMocks>;

// What api-client.ts ships with, read before any test changes it, so a test
// that asserts a default checks the production value and not a copy of it.
const API_CLIENT_DEFAULTS = {
  maxRetries: ApiClient.maxRetries,
  timeoutMs: ApiClient.timeoutMs,
};

/**
 * Resets every module's private static singleton so each test starts from a
 * state equivalent to a genuinely fresh MV3 service-worker instantiation (a
 * real restart gets a brand-new JS realm; these classes cache themselves in a
 * `static` field that would otherwise leak across tests sharing this
 * process/module cache).
 */
export function resetSingletons() {
  (NotificationsState as any).notificationsState = undefined;
  (Dismiss as any).dismiss = undefined;
  (PushNotificationEvents as any).pushNotificationEvents = undefined;
  (ReceiveNotification as any).instance = undefined;
  (PermissionWatcher as any).instance = undefined;
  ApiClient.maxRetries = API_CLIENT_DEFAULTS.maxRetries;
  // Not the production default: the tests do not wait out a real backoff.
  ApiClient.retryBaseDelayMs = 1;
  ApiClient.timeoutMs = API_CLIENT_DEFAULTS.timeoutMs;
  (PushNotificationStorage as any).anonymousId = undefined;
  (PushNotificationStorage as any).memoryDetails = undefined;
  (RegisterSubscription as any).warnedHashWithoutId = false;
  // A registration a test left hanging must not hold up the next test's.
  (RegisterSubscription as any).queue = Promise.resolve();
}
