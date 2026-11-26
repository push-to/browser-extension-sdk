/**
 * Failure and ordering cases: storage that rejects, closes the user did not
 * make, events that straddle a worker restart, the registration and VAPID
 * caches' max age, and the fetch wrapper's limits. Mocked environment in
 * ./test-env.ts; no network.
 *
 * Run: bun test src/lib/__tests__/hardening.test.ts
 * (run from packages/chrome-extension)
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { ApiClient, PushToApiError, resolveApiBaseUrl } from '../api-client';
import { PushNotificationStorage } from '../push-notification-storage';
import { PushNotifications } from '../pushto-chrome-extension';
import { REGISTRATION_MAX_AGE_MS, toUserBody } from '../register-subscription';
import {
  API_BASE_URL,
  installMocks,
  jsonResponse,
  resetSingletons,
  sleep,
  TestEnv,
  vapidKey,
} from './test-env';

let env: TestEnv;
let warnings: unknown[][];
let unhandled: unknown[];
const originalWarn = console.warn;
const onUnhandled = (reason: unknown) => unhandled.push(reason);

beforeEach(() => {
  env = installMocks();
  resetSingletons();
  warnings = [];
  unhandled = [];
  console.warn = (...args: unknown[]) => warnings.push(args);
  process.on('unhandledRejection', onUnhandled);
});

afterEach(() => {
  console.warn = originalWarn;
  process.off('unhandledRejection', onUnhandled);
});

function init(
  options: Partial<ConstructorParameters<typeof PushNotifications>[0]> = {},
) {
  return new PushNotifications({
    apiKey: 'browser-key',
    apiBaseUrl: API_BASE_URL,
    ...options,
  });
}

const push = (notificationId: number, data: object = {}) =>
  env.push({ title: 't', body: 'b', notification_id: notificationId, data });

const requests = () => env.fetchCalls.map((c) => `${c.method} ${c.path}`);

const HOUR = 60 * 60 * 1000;

describe('storage failures (M1)', () => {
  test('chrome.storage.local.set rejecting does not stop the notification from being shown', async () => {
    init();
    env.storageSetError = 'QUOTA_BYTES quota exceeded';

    expect(await push(1, { url: 'https://example.com', tag: 'grp' })).toBe(1);

    expect(env.active.has('1')).toBe(true);
    expect(env.createCalls.length).toBe(1);
    expect(env.feedbackTypes(1)).toEqual(['delivered']);
    expect(String(warnings[0][0])).toContain('persist');
    expect(unhandled).toEqual([]);
  });

  test('a rejecting tag cleanup does not stop it either', async () => {
    init();
    await push(2, { tag: 'grp' });
    env.storageSetError = 'QUOTA_BYTES quota exceeded';

    await push(3, { tag: 'grp' });

    expect(env.active.has('3')).toBe(true);
    expect(env.feedbackTypes(3)).toEqual(['delivered']);
    expect(unhandled).toEqual([]);
  });

  test('a click on a notification whose state could not be stored still clears it, without feedback', async () => {
    init();
    env.storageSetError = 'QUOTA_BYTES quota exceeded';
    await push(4, { url: 'https://example.com' });

    env.click('4');
    await sleep(20);

    expect(env.active.has('4')).toBe(false);
    expect(env.tabsCreateCalls).toEqual([]);
    expect(env.feedbackTypes(4)).toEqual(['delivered']);
    expect(unhandled).toEqual([]);
  });
});

describe('tag replacement', () => {
  const stored = () => Object.keys(env.storage['pt_notifications'] ?? {});

  test('a notification that cannot be shown leaves the one it would have replaced on screen and in storage', async () => {
    init();
    await push(5, { tag: 'grp' });
    env.createError = () => 'Notifications permission missing';

    await push(6, { tag: 'grp' });
    await sleep(20);

    expect([...env.active.keys()]).toEqual(['5']);
    expect(stored()).toEqual(['5']);
    expect(env.feedbackTypes(6)).toEqual([]);

    // The survivor is still a tracked notification.
    env.userClose('5');
    await sleep(20);
    expect(env.feedbackTypes(5)).toEqual(['delivered', 'dismissed']);
    expect(unhandled).toEqual([]);
  });

  test('two pushes with the same tag handled at the same time end with one on screen and in storage', async () => {
    init();

    await Promise.all([push(7, { tag: 'grp' }), push(8, { tag: 'grp' })]);
    await sleep(20);

    expect([...env.active.keys()]).toEqual(['8']);
    expect(stored()).toEqual(['8']);
    expect(env.feedbackTypes(7)).toEqual(['delivered']);
    expect(env.feedbackTypes(8)).toEqual(['delivered']);
    expect(unhandled).toEqual([]);
  });

  test('a slow `delivered` post does not delay the next notification', async () => {
    init();
    env.intercept = async (call) => {
      if (call.path === '/v1/feedback') await sleep(60);
      return undefined;
    };

    const first = push(9, { tag: 'a' });
    const second = push(14, { tag: 'b' });
    await sleep(20);

    expect([...env.active.keys()]).toEqual(['9', '14']);
    expect(env.feedback().length).toBe(2); // both posts are still in flight
    await Promise.all([first, second]);
  });
});

describe('`dismissed` only for a close the user made (S2)', () => {
  test('byUser === true → dismissed', async () => {
    init();
    await push(10);
    env.userClose('10');
    await sleep(20);
    expect(env.feedbackTypes(10)).toEqual(['delivered', 'dismissed']);
  });

  test('a close the SDK did not cause with byUser === false → nothing, and the state is still removed', async () => {
    init();
    await push(11, {
      auto_dismiss: { behavior: 'timed', dismiss_time_ms: 120_000 },
    });

    env.systemClose('11');
    await sleep(20);

    expect(env.feedbackTypes(11)).toEqual(['delivered']);
    expect(env.storage['pt_notifications']).toEqual({});
    expect(env.alarms.has('pt-dismiss:11')).toBe(false);
  });

  test('a missing byUser argument is not treated as a user close', async () => {
    init();
    await push(12);
    env.active.delete('12');
    env.notificationsOnClosed.listeners.forEach((l) => l('12'));
    await sleep(20);
    expect(env.feedbackTypes(12)).toEqual(['delivered']);
  });
});

describe('close with unreadable state', () => {
  test('a failed read on a user close still removes the stored entry', async () => {
    init();
    await push(13);
    const get = (globalThis as any).chrome.storage.local.get;
    let fail = true;
    (globalThis as any).chrome.storage.local.get = async (key: string) => {
      if (fail) {
        fail = false;
        throw new Error('storage unavailable');
      }
      return get(key);
    };

    env.userClose('13');
    await sleep(20);

    expect(env.storage['pt_notifications']).toEqual({});
    expect(env.feedbackTypes(13)).toEqual(['delivered']); // what to report was unreadable
    expect(warnings.length).toBe(1);
    expect(String(warnings[0][0])).toContain('could not read');
    expect(unhandled).toEqual([]);
  });
});

describe('click / auto-dismiss never followed by `dismissed` (S5)', () => {
  test('a push-api notification clicked after a worker restart still sends clicked and opened', async () => {
    init();
    await push(20, {
      url: 'https://example.com/deep',
      badge: { text: '1' },
    });

    env.restartWorker();
    init();
    env.fetchCalls.length = 0;
    env.click('20');
    await sleep(20);

    expect(env.feedbackTypes(20)).toEqual(['clicked', 'opened']);
    expect(env.tabsCreateCalls).toEqual([{ url: 'https://example.com/deep' }]);
    expect(env.badgeTextCalls).toEqual(['1', '']);
    expect(env.active.has('20')).toBe(false);
    expect(env.storage['pt_notifications']).toEqual({});
  });

  test('onClosed dispatched before the click handler has awaited anything is not a dismissal', async () => {
    init();
    await push(21, { url: 'https://example.com/deep' });

    // The platform closes the notification as part of the click, and both
    // events are dispatched back to back.
    env.click('21');
    env.active.delete('21');
    env.notificationsOnClosed.listeners.forEach((l) => l('21', true));
    await sleep(20);

    expect(env.feedbackTypes(21)).toEqual(['delivered', 'clicked', 'opened']);
    expect(env.tabsCreateCalls).toEqual([{ url: 'https://example.com/deep' }]);
  });

  test('click: the onClosed of clear() arriving in a fresh worker is not a dismissal', async () => {
    init();
    await push(22, { url: 'https://example.com/deep' });

    // The worker dies after clear() and before its onClosed is dispatched.
    env.clearFiresOnClosed = false;
    env.click('22');
    await sleep(20);
    expect(env.feedbackTypes(22)).toEqual(['delivered', 'clicked', 'opened']);
    expect(env.storage['pt_notifications']).toEqual({}); // removed before clear()

    env.restartWorker();
    init();
    // Whatever byUser says: the fresh worker has no memory of the clear().
    env.notificationsOnClosed.listeners.forEach((l) => l('22', true));
    await sleep(20);

    expect(env.feedbackTypes(22)).toEqual(['delivered', 'clicked', 'opened']);
    expect(unhandled).toEqual([]);
  });

  test('auto-dismiss: the onClosed of clear() arriving in a fresh worker is not a dismissal', async () => {
    init();
    await push(23, {
      auto_dismiss: { behavior: 'timed', dismiss_time_ms: 120_000 },
    });

    env.clearFiresOnClosed = false;
    env.fireAlarm('pt-dismiss:23');
    await sleep(20);
    expect(env.active.has('23')).toBe(false);
    expect(env.storage['pt_notifications']).toEqual({}); // removed before clear()

    env.restartWorker();
    init();
    env.notificationsOnClosed.listeners.forEach((l) => l('23', true));
    await sleep(20);

    expect(env.feedbackTypes(23)).toEqual(['delivered']);
  });

  test('a short auto-dismiss removes the stored entry before clearing too', async () => {
    init();
    await push(24, {
      auto_dismiss: { behavior: 'timed', dismiss_time_ms: 20 },
    });
    env.clearFiresOnClosed = false;

    await sleep(80);

    expect(env.active.has('24')).toBe(false);
    expect(env.storage['pt_notifications']).toEqual({});
  });
});

describe('registration cache max age (S3)', () => {
  const age = (key: string, field: string, ms: number) => {
    env.storage[key][field] -= ms;
  };

  test('an unchanged registration is re-sent once it is 24 hours old, and not before', async () => {
    await init().registerPushSubscription({ id: 'user-1' });
    const first = env.storage['pt_registration'].registeredAt;
    expect(Math.abs(Date.now() - first)).toBeLessThan(5_000);

    age('pt_registration', 'registeredAt', 23 * HOUR);
    env.fetchCalls.length = 0;
    await init().registerPushSubscription({ id: 'user-1' });
    expect(requests()).toEqual([]);

    age('pt_registration', 'registeredAt', 2 * HOUR); // 25 h in total
    await init().registerPushSubscription({ id: 'user-1' });
    expect(requests()).toEqual(['GET /v1/vapid-key', 'POST /v1/subscriptions']);
    expect(env.subscribeCalls.length).toBe(1); // the subscription is reused
    expect(
      Math.abs(Date.now() - env.storage['pt_registration'].registeredAt),
    ).toBeLessThan(5_000);

    env.fetchCalls.length = 0;
    await init().registerPushSubscription({ id: 'user-1' });
    expect(requests()).toEqual([]);
    expect(REGISTRATION_MAX_AGE_MS).toBe(24 * HOUR);
  });

  test('with `vapidPublicKey` a stale registration re-sends the POST only', async () => {
    const options = { vapidPublicKey: vapidKey(1) };
    await init(options).registerPushSubscription();
    age('pt_registration', 'registeredAt', 25 * HOUR);
    env.fetchCalls.length = 0;

    await init(options).registerPushSubscription();

    expect(requests()).toEqual(['POST /v1/subscriptions']);
  });

  test('a stored time in the future (clock set back) is not trusted', async () => {
    await init().registerPushSubscription();
    age('pt_registration', 'registeredAt', -48 * HOUR);
    env.fetchCalls.length = 0;

    await init().registerPushSubscription();

    expect(requests()).toContain('POST /v1/subscriptions');
  });

  test('a cache entry without a timestamp (or garbage) is ignored', async () => {
    await init().registerPushSubscription();
    for (const stale of [
      { userId: 42, fingerprint: env.storage['pt_registration'].fingerprint },
      'garbage',
      null,
    ]) {
      env.storage['pt_registration'] = stale;
      env.fetchCalls.length = 0;
      await init().registerPushSubscription();
      expect(requests()).toContain('POST /v1/subscriptions');
    }
  });
});

describe('VAPID key cache (S4)', () => {
  test('an unchanged re-register on a later worker start makes no request at all', async () => {
    await init().registerPushSubscription({ id: 'user-1' });
    expect(requests()).toEqual(['GET /v1/vapid-key', 'POST /v1/subscriptions']);
    expect(env.storage['pt_vapidKey']).toEqual({
      publicKey: env.serverVapidKey,
      baseUrl: `${API_BASE_URL}/v1`,
      fetchedAt: env.storage['pt_registration'].registeredAt,
    });

    env.fetchCalls.length = 0;
    for (let start = 0; start < 3; start++) {
      env.restartWorker();
      await init().registerPushSubscription({ id: 'user-1' });
    }
    expect(requests()).toEqual([]);
    expect(env.unsubscribeCalls).toBe(0);
  });

  test('the cached key expires after 24 hours on its own', async () => {
    await init().registerPushSubscription();
    env.storage['pt_vapidKey'].fetchedAt -= 25 * HOUR;
    env.fetchCalls.length = 0;

    await init().registerPushSubscription();

    expect(requests()).toEqual(['GET /v1/vapid-key']); // registration itself is fresh
    expect(
      Math.abs(Date.now() - env.storage['pt_vapidKey'].fetchedAt),
    ).toBeLessThan(5_000);
  });

  test('a full registration always reads the key again', async () => {
    await init().registerPushSubscription({ id: 'user-1' });
    env.fetchCalls.length = 0;

    await init().registerPushSubscription({ id: 'user-2' });

    expect(requests()).toEqual(['GET /v1/vapid-key', 'POST /v1/subscriptions']);
    expect(env.unsubscribeCalls).toBe(0);
  });

  test('a rotated server key is picked up when the cache expires: resubscribe, then register the new endpoint', async () => {
    await init().registerPushSubscription();
    expect(env.subscription.endpoint).toMatch(/sub-1$/);
    env.serverVapidKey = vapidKey(2);

    // Within the max age the stored key is still used: nothing happens.
    env.fetchCalls.length = 0;
    await init().registerPushSubscription();
    expect(requests()).toEqual([]);
    expect(env.unsubscribeCalls).toBe(0);

    env.storage['pt_registration'].registeredAt -= 25 * HOUR;
    await init().registerPushSubscription();

    expect(env.unsubscribeCalls).toBe(1);
    expect(env.subscription.endpoint).toMatch(/sub-2$/);
    expect(
      new Uint8Array(env.subscription.options.applicationServerKey)[1],
    ).toBe(2);
    expect(env.fetchCalls.at(-1)?.body.subscription.endpoint).toMatch(/sub-2$/);
    expect(env.storage['pt_vapidKey'].publicKey).toBe(vapidKey(2));
  });

  test('a rotated key is also picked up by a full registration caused by something else', async () => {
    await init().registerPushSubscription({ id: 'user-1' });
    env.serverVapidKey = vapidKey(3);
    env.fetchCalls.length = 0;

    await init().registerPushSubscription({ id: 'user-1', name: 'New Name' });

    expect(env.unsubscribeCalls).toBe(1);
    expect(env.subscription.endpoint).toMatch(/sub-2$/);
    expect(requests()).toEqual(['GET /v1/vapid-key', 'POST /v1/subscriptions']);
    expect(env.fetchCalls[1].body.subscription.endpoint).toMatch(/sub-2$/);
    expect(env.fetchCalls[1].body.first_name).toBe('New');
  });

  test('the cached key is not used for another API host, nor without a subscription', async () => {
    await init().registerPushSubscription();

    env.fetchCalls.length = 0;
    await init({ apiBaseUrl: 'https://other.test' }).registerPushSubscription();
    expect(env.fetchCalls[0].url).toBe('https://other.test/v1/vapid-key');

    await env.subscription.unsubscribe();
    env.fetchCalls.length = 0;
    await init({ apiBaseUrl: 'https://other.test' }).registerPushSubscription();
    expect(requests()[0]).toBe('GET /v1/vapid-key');
  });

  test('the `vapidPublicKey` option is never cached and never fetched', async () => {
    await init({ vapidPublicKey: vapidKey(5) }).registerPushSubscription();
    expect(env.storage['pt_vapidKey']).toBeUndefined();
    expect(requests()).toEqual(['POST /v1/subscriptions']);
  });
});

describe('subscription without an exposed key (S7)', () => {
  const hideKeyAndFailSubscribeWith = (error: unknown) => {
    env.subscription.options = { applicationServerKey: null };
    (globalThis as any).self.registration.pushManager.subscribe = async (
      options: unknown,
    ) => {
      env.subscribeCalls.push(options);
      throw error;
    };
  };

  test('a subscribe() failure that is not InvalidStateError is rethrown and the subscription is kept', async () => {
    const options = { vapidPublicKey: vapidKey(1) };
    await init(options).registerPushSubscription();
    const existing = env.subscription;

    for (const error of [
      new DOMException(
        'Registration failed - permission denied',
        'NotAllowedError',
      ),
      new DOMException('push service error', 'AbortError'),
      new TypeError('network'),
      'a string',
      null,
    ]) {
      hideKeyAndFailSubscribeWith(error);
      // A changed user, so the call cannot return early on the cache.
      const outcome = await init(options)
        .registerPushSubscription({ id: `user-${Math.random()}` })
        .then(
          () => 'resolved',
          (e) => e,
        );
      expect(outcome).toBe(error);
    }

    expect(env.unsubscribeCalls).toBe(0);
    expect(env.subscription).toBe(existing);
  });

  test('InvalidStateError still replaces it', async () => {
    await init({ vapidPublicKey: vapidKey(1) }).registerPushSubscription();
    const realSubscribe = (globalThis as any).self.registration.pushManager
      .subscribe;
    let calls = 0;
    env.subscription.options = { applicationServerKey: null };
    (globalThis as any).self.registration.pushManager.subscribe = async (
      options: unknown,
    ) => {
      if (++calls === 1) {
        throw new DOMException('another key', 'InvalidStateError');
      }
      return realSubscribe(options);
    };

    await init({ vapidPublicKey: vapidKey(2) }).registerPushSubscription();

    expect(env.unsubscribeCalls).toBe(1);
    expect(env.subscription.endpoint).toMatch(/sub-2$/);
  });
});

describe('identity', () => {
  test('a finite numeric id is an identity, not anonymous', () => {
    expect(toUserBody({ id: 12345 }, 'a1')).toEqual({
      external_id: '12345',
    });
    expect(toUserBody({ id: 0 }, 'a1')).toEqual({
      external_id: '0',
    });
    for (const notAnId of [NaN, Infinity, {}, [], true, null]) {
      expect(toUserBody({ id: notAnId as unknown as string }, 'a1')).toEqual({
        external_id: 'anon:a1',
      });
    }
  });

  test('two concurrent first registrations share one anonymous id', async () => {
    // Both reads see the storage as it was before either call wrote to it.
    const get = (globalThis as any).chrome.storage.local.get;
    (globalThis as any).chrome.storage.local.get = async (key: string) => {
      const snapshot = await get(key);
      await sleep(5);
      return snapshot;
    };
    const sdk = init({ vapidPublicKey: vapidKey(1) });

    // Registrations run one at a time, so the two reads that overlap are
    // made directly; the second registration differs so that it is sent.
    const [a, b] = await Promise.all([
      PushNotificationStorage.getAnonymousId(),
      PushNotificationStorage.getAnonymousId(),
      sdk.registerPushSubscription(),
      sdk.registerPushSubscription({ email: 'a@example.com' }),
    ]);
    expect(a).toBe(b);
    expect(a).toBe(env.storage['pt_anonymousId']);

    const registrations = env.fetchCalls.filter(
      (c) => c.path === '/v1/subscriptions',
    );
    const externalIds = registrations.map((c) => c.body.external_id);
    expect(externalIds.length).toBe(2);
    expect(new Set(externalIds).size).toBe(1);
    expect(externalIds[0]).toBe(`anon:${env.storage['pt_anonymousId']}`);
    const anonymousIds = registrations.map((c) => c.body.metadata.anonymous_id);
    expect(new Set(anonymousIds)).toEqual(
      new Set([env.storage['pt_anonymousId']]),
    );
  });

  test('two overlapping registrations for different users are sent in call order, and the last one is the one remembered', async () => {
    const sdk = init({ vapidPublicKey: vapidKey(1) });
    // The first answer is the slow one: unserialized, it would be stored last.
    env.intercept = async (call) => {
      if (String(call.body?.external_id).startsWith('anon:')) await sleep(40);
      return undefined;
    };

    await Promise.all([
      sdk.registerPushSubscription(),
      sdk.registerPushSubscription({ id: 'user-1' }),
    ]);

    const sent = () =>
      env.fetchCalls
        .filter((c) => c.path === '/v1/subscriptions')
        .map((c) => c.body.external_id);
    expect(sent()).toEqual([`anon:${env.storage['pt_anonymousId']}`, 'user-1']);

    env.intercept = undefined;
    await sdk.registerPushSubscription({ id: 'user-1' });
    expect(sent().length).toBe(2); // remembered: nothing sent
    await sdk.registerPushSubscription();
    expect(sent().length).toBe(3);
  });

  test('a registration that fails does not hold up the next one, and each caller gets its own result', async () => {
    const sdk = init({ vapidPublicKey: vapidKey(1) });
    env.intercept = (call) =>
      call.body?.external_id === 'user-1'
        ? jsonResponse(422, {
            error: { code: 'validation_error', message: 'refused' },
          })
        : undefined;

    const [first, second] = await Promise.allSettled([
      sdk.registerPushSubscription({ id: 'user-1' }),
      sdk.registerPushSubscription({ id: 'user-2' }),
    ]);

    expect(first.status).toBe('rejected');
    expect((first as PromiseRejectedResult).reason).toMatchObject({
      status: 422,
      code: 'validation_error',
    });
    expect(second.status).toBe('fulfilled');
    expect(unhandled).toEqual([]);

    await sdk.registerPushSubscription({ id: 'user-2' });
    expect(requests()).toEqual([
      'POST /v1/subscriptions',
      'POST /v1/subscriptions',
    ]);
  });

  test('a failed anonymous-id read is not remembered', async () => {
    const get = (globalThis as any).chrome.storage.local.get;
    let fail = true;
    (globalThis as any).chrome.storage.local.get = async (key: string) => {
      if (fail && key === 'pt_anonymousId') throw new Error('storage down');
      return get(key);
    };
    const sdk = init({ vapidPublicKey: vapidKey(1) });

    await expect(sdk.registerPushSubscription()).rejects.toThrow(
      'storage down',
    );
    fail = false;
    await sdk.registerPushSubscription();

    expect(env.storage['pt_anonymousId']).toMatch(/^[0-9a-f-]{36}$/);
    await sleep(5);
    expect(unhandled).toEqual([]);
  });
});

describe('base URL limits', () => {
  test('http is accepted for loopback hosts only', () => {
    for (const ok of [
      'http://localhost:3000',
      'http://127.0.0.1:3000',
      'http://[::1]:3000',
      'http://api.localhost',
    ]) {
      expect(resolveApiBaseUrl(ok, '')).toBe(`${ok}/v1`);
    }
    for (const bad of [
      'http://api.example.com',
      'http://192.168.1.10:3000',
      'http://localhost.example.com',
      'http://127.0.0.1.example.com',
    ]) {
      expect(() => resolveApiBaseUrl(bad, '')).toThrow(/apiBaseUrl/);
    }
    expect(() => init({ apiBaseUrl: 'http://api.example.com' })).toThrow(
      /apiBaseUrl/,
    );
  });

  test('a query or fragment is refused', () => {
    for (const bad of [
      'https://api.example.com?tenant=1',
      'https://api.example.com/?tenant=1',
      'https://api.example.com/base?x=y/v1',
      'https://api.example.com#frag',
      'https://api.example.com/v1#frag',
      // An empty one: `URL` reports no query or fragment for these.
      'https://api.test?',
      'https://api.test#',
      'https://api.test/?',
      'https://api.test/#',
    ]) {
      expect(() => resolveApiBaseUrl(bad, '')).toThrow(/apiBaseUrl/);
    }
  });
});

describe('fetch timeout', () => {
  const api = () => new ApiClient('k', `${API_BASE_URL}/v1`);
  const SUBSCRIPTION_BODY = {
    external_id: 'u',
    subscription: {
      endpoint: 'https://fcm.googleapis.com/fcm/send/x',
      keys: { p256dh: 'p', auth: 'a' },
    },
    metadata: {},
  };
  /** A server that never answers: the fetch settles only when aborted. */
  const hang = (call: { signal?: AbortSignal }) =>
    new Promise<Response>((_resolve, reject) => {
      call.signal?.addEventListener('abort', () => reject(call.signal?.reason));
    });

  test('every request carries an abort signal', async () => {
    await api().getVapidPublicKey();
    await api().sendFeedback({ notification_id: 1, event_type: 'delivered' });
    for (const call of env.fetchCalls) {
      expect(call.signal).toBeInstanceOf(AbortSignal);
      expect(call.signal?.aborted).toBe(false);
    }
  });

  test('a request that hangs is aborted and retried like a network error, within the retry bound', async () => {
    ApiClient.timeoutMs = 20;
    let attempts = 0;
    env.intercept = (call) => (++attempts === 1 ? hang(call) : undefined);

    await api().registerSubscription(SUBSCRIPTION_BODY);
    expect(env.fetchCalls.length).toBe(2);
    expect(env.fetchCalls[0].signal?.aborted).toBe(true);
    expect(env.fetchCalls[1].signal).not.toBe(env.fetchCalls[0].signal); // one timer per attempt

    env.fetchCalls.length = 0;
    env.intercept = hang;
    const started = performance.now();
    const error = await api()
      .getVapidPublicKey()
      .catch((e) => e);
    expect(error).toBeInstanceOf(PushToApiError);
    expect(error).toMatchObject({ status: 0, code: 'network_error' });
    expect(env.fetchCalls.length).toBe(3); // 1 attempt + 2 retries
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  test('a hanging feedback post is bounded and never rejects', async () => {
    ApiClient.timeoutMs = 20;
    init();
    env.intercept = (call) =>
      call.path === '/v1/feedback' ? hang(call) : undefined;

    const started = performance.now();
    expect(await push(30)).toBe(1); // resolves: waitUntil is not held forever

    expect(performance.now() - started).toBeLessThan(1_000);
    expect(env.active.has('30')).toBe(true);
    expect(warnings.length).toBe(1);
    expect(unhandled).toEqual([]);
  });

  test('a browser without AbortSignal.timeout still makes the request', async () => {
    const original = AbortSignal.timeout;
    (AbortSignal as any).timeout = undefined;
    try {
      expect(await api().getVapidPublicKey()).toBe(env.serverVapidKey);
      expect(env.fetchCalls[0].signal).toBeUndefined();
    } finally {
      AbortSignal.timeout = original;
    }
  });

  test('the default is 10 seconds', () => {
    resetSingletons();
    expect(ApiClient.timeoutMs).toBe(10_000);
  });
});

describe('feedback body (S1)', () => {
  test('no client timestamp is sent: push-api stamps the event', async () => {
    init();
    await push(40, { url: 'https://example.com' });
    env.click('40');
    await push(41);
    env.userClose('41');
    await sleep(20);

    expect(env.feedback().length).toBe(5);
    for (const call of env.feedback()) {
      expect('occurred_at' in call.body).toBe(false);
      expect(Object.keys(call.body).sort()).toEqual([
        'event_type',
        'notification_id',
      ]);
    }
  });

  test('a 422 from the API is logged, not retried and not thrown', async () => {
    init();
    env.intercept = (call) =>
      call.path === '/v1/feedback'
        ? jsonResponse(422, {
            error: { code: 'validation_error', message: 'nope' },
          })
        : undefined;

    await push(42);

    expect(env.feedback().length).toBe(1);
    expect(warnings.length).toBe(1);
    expect(unhandled).toEqual([]);
  });
});
