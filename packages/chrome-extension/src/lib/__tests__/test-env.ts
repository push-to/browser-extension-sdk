/**
 * Mocked MV3 service-worker environment shared by the tests: `chrome.*`,
 * `self` (push listeners + pushManager), `fetch` (a fake push-api) and
 * `navigator`. Nothing here touches the network.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { ApiClient } from '../api-client';
import { Dismiss } from '../dismiss';
import { NotificationsState } from '../notifications-state';
import { PushNotificationEvents } from '../push-notification-events';
import { PushNotificationStorage } from '../push-notification-storage';
import { ReceiveNotification } from '../receive-notification';

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
    pushListeners: [] as Listener[],

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
    /** The user closes a notification: onClosed with no clear() before it. */
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
      ]) {
        listeners.length = 0;
      }
    },
    userClose(id: string) {
      env.active.delete(id);
      env.notificationsOnClosed.listeners.forEach((l) => l(id, true));
    },
    fireAlarm(name: string) {
      env.alarmsOnAlarm.listeners.forEach((l) => l({ name }));
    },
  };

  let subscriptionCounter = 0;
  const sameKey = (a: ArrayBuffer, b: Uint8Array) =>
    base64Url(new Uint8Array(a)) === base64Url(b);

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
    if (call.method === 'POST' && call.path === '/v1/users') {
      return jsonResponse(201, { id: env.userId, ...call.body });
    }
    if (
      call.method === 'POST' &&
      /^\/v1\/users\/\d+\/endpoints$/.test(call.path)
    ) {
      return jsonResponse(201, { id: 7, channel: 'web_push' });
    }
    if (call.method === 'POST' && call.path === '/v1/feedback') {
      return jsonResponse(202, { accepted: true });
    }
    return jsonResponse(404, {
      error: { code: 'not_found', message: 'no such route' },
    });
  };

  const chromeMock: any = {
    storage: {
      local: {
        get: async (key: string) => ({ [key]: env.storage[key] }),
        set: async (obj: Record<string, any>) => {
          if (env.storageSetError) {
            throw new Error(env.storageSetError);
          }
          // chrome.storage round-trips values through JSON.
          Object.assign(env.storage, JSON.parse(JSON.stringify(obj)));
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
    notifications: {
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
    },
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
    runtime: {
      id: 'ext-test-id',
      lastError: undefined,
      getURL: (p: string) =>
        `chrome-extension://ext-test-id/${p.replace(/^\//, '')}`,
      getManifest: () => env.manifest,
    },
  };
  (globalThis as any).chrome = chromeMock;

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
        getSubscription: async () => env.subscription,
        subscribe: async (options: any) => {
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
  ApiClient.maxRetries = 2;
  ApiClient.retryBaseDelayMs = 1;
  ApiClient.timeoutMs = 10_000;
  (PushNotificationStorage as any).anonymousId = undefined;
}
