/**
 * Optional `notifications` permission, identify / reset, registration
 * results, getState, unsubscribe, sendTestNotification and the page helper.
 * Mocked environment in ./test-env.ts; no network.
 *
 * Run: bun test src/lib/__tests__/integrator-feedback.test.ts
 * (run from packages/chrome-extension)
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { PushToApiError } from '../api-client';
import { PushNotifications } from '../pushto-chrome-extension';
import * as publicApi from '../../index';
import * as pageApi from '../../page';
import {
  API_BASE_URL,
  IDENTITY_SECRET,
  installMocks,
  jsonResponse,
  resetSingletons,
  sleep,
  TestEnv,
  userHash,
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
  expect(unhandled).toEqual([]);
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

const requests = () => env.fetchCalls.map((c) => `${c.method} ${c.path}`);
const registrations = () =>
  env.fetchCalls.filter(
    (c) => c.method === 'POST' && c.path === '/v1/subscriptions',
  );
const HOUR = 60 * 60 * 1000;
const ANON = /^anon:[0-9a-f-]{36}$/;

const notificationListeners = () => ({
  clicked: env.notificationsOnClicked.listeners.length,
  closed: env.notificationsOnClosed.listeners.length,
});

describe('optional `notifications` permission', () => {
  test('the constructor does not throw without chrome.notifications, and adds every listener but the notification ones', () => {
    env.withoutNotificationsPermission();

    expect(() => init()).not.toThrow();

    expect(notificationListeners()).toEqual({ clicked: 0, closed: 0 });
    expect(env.pushListeners.length).toBe(1);
    expect(env.alarmsOnAlarm.listeners.length).toBe(1);
    expect(env.actionOnClicked.listeners.length).toBe(1);
    expect(env.permissionsOnAdded.listeners.length).toBe(1);
    expect(env.permissionsOnRemoved.listeners.length).toBe(1);
    expect(env.fetchCalls).toEqual([]);
  });

  test('a runtime without chrome.permissions or chrome.alarms does not break the constructor', () => {
    delete (globalThis as any).chrome.permissions;
    delete (globalThis as any).chrome.alarms;

    expect(() => init()).not.toThrow();
    expect(env.pushListeners.length).toBe(1);
    // Without `permissions.contains` the presence of the API decides.
    expect(notificationListeners()).toEqual({ clicked: 1, closed: 2 });
  });

  test('registering without the permission resolves `permission_required`: no pushManager call, no request, identity remembered', async () => {
    env.withoutNotificationsPermission();
    const hash = await userHash(IDENTITY_SECRET, 'user-1');

    const result = await init().identify({
      id: 'user-1',
      hash,
      email: 'jane@example.com',
    });

    expect(result).toEqual({
      status: 'permission_required',
      externalId: 'user-1',
    });
    expect(env.pushManagerCalls).toBe(0);
    expect(env.fetchCalls).toEqual([]);
    expect(env.storage['pt_identity']).toEqual({ id: 'user-1', details: true });
    expect(env.session['pt_identity']).toEqual({
      user: { id: 'user-1', hash, email: 'jane@example.com' },
    });
    expect(env.storage['pt_registration']).toBeUndefined();

    // Anonymous: the external id that will be registered.
    const anonymous = await init().reset();
    expect(anonymous.status).toBe('permission_required');
    expect(anonymous.externalId).toBe(`anon:${env.storage['pt_anonymousId']}`);
    expect(env.pushManagerCalls).toBe(0);
  });

  test('permissions.onAdded attaches the notification listeners once and registers with the remembered identity', async () => {
    env.withoutNotificationsPermission();
    const hash = await userHash(IDENTITY_SECRET, 'user-1');
    await init().identify({ id: 'user-1', hash, name: 'Jane Doe' });

    env.grantNotifications();
    // Synchronously, in the event handler.
    expect(notificationListeners()).toEqual({ clicked: 1, closed: 2 });
    await sleep(20);

    expect(requests()).toEqual(['GET /v1/vapid-key', 'POST /v1/subscriptions']);
    expect(registrations()[0].body).toMatchObject({
      external_id: 'user-1',
      user_hash: hash,
      first_name: 'Jane',
      last_name: 'Doe',
    });
    expect(env.storage['pt_registration'].userId).toBe(42);

    // The event again (or another grant) duplicates nothing.
    env.grantNotifications();
    env.grantNotifications();
    await sleep(20);
    expect(notificationListeners()).toEqual({ clicked: 1, closed: 2 });
    expect(registrations().length).toBe(1);

    // And the notification is displayed and tracked like any other.
    await env.push({ title: 't', body: 'b', notification_id: 5, data: {} });
    expect(env.active.has('5')).toBe(true);
    expect(env.feedbackTypes(5)).toEqual(['delivered']);
  });

  test('the remembered identity survives a worker restart: the new worker registers it on the grant without being asked', async () => {
    env.withoutNotificationsPermission();
    await init().identify({ id: 'user-1' });

    env.restartWorker();
    init(); // top-level init only: no identify() in this worker
    env.grantNotifications();
    await sleep(20);

    expect(registrations().map((c) => c.body.external_id)).toEqual(['user-1']);
    expect(notificationListeners()).toEqual({ clicked: 1, closed: 2 });
  });

  test('a worker started with the permission already granted attaches the listeners at top level', () => {
    env.withoutNotificationsPermission();
    init();
    env.grantNotifications({ fireEvent: false });

    env.restartWorker();
    init();
    expect(notificationListeners()).toEqual({ clicked: 1, closed: 2 });
  });

  test('a grant of another permission, or a grant when nothing was asked for, registers nothing', async () => {
    env.withoutNotificationsPermission();
    init();

    env.permissionsOnAdded.listeners.forEach((l) =>
      l({ permissions: ['tabs'], origins: [] }),
    );
    expect(notificationListeners()).toEqual({ clicked: 0, closed: 0 });

    env.grantNotifications();
    await sleep(20);
    expect(notificationListeners()).toEqual({ clicked: 1, closed: 2 });
    expect(env.fetchCalls).toEqual([]);
    expect(env.pushManagerCalls).toBe(0);
  });

  test('if chrome.notifications does not appear in the running worker, the grant still registers and the listeners are attached before the first display', async () => {
    env.withoutNotificationsPermission();
    await init().reset();

    env.grantNotifications({ exposeApi: false });
    await sleep(20);
    expect(registrations().length).toBe(1);
    expect(notificationListeners()).toEqual({ clicked: 0, closed: 0 });

    // A push in that state shows nothing and does not throw.
    expect(
      await env.push({ title: 't', body: 'b', notification_id: 1, data: {} }),
    ).toBe(1);
    expect(env.createCalls).toEqual([]);
    expect(env.feedback()).toEqual([]);

    // The API appears without an event: attached lazily, once.
    env.grantNotifications({ fireEvent: false });
    await env.push({ title: 't', body: 'b', notification_id: 2, data: {} });
    await env.push({ title: 't', body: 'b', notification_id: 3, data: {} });
    expect(env.active.has('2')).toBe(true);
    expect(notificationListeners()).toEqual({ clicked: 1, closed: 2 });
    env.click('3');
    await sleep(20);
    expect(env.feedbackTypes(3)).toEqual(['delivered', 'clicked']);
  });

  test('a push received while the API is missing does not throw: logged, nothing shown, nothing stored', async () => {
    env.withoutNotificationsPermission();
    init();

    const waits = await env.push({
      title: 't',
      body: 'b',
      notification_id: 9,
      data: {
        tag: 'x',
        auto_dismiss: { behavior: 'timed', dismiss_time_ms: 1 },
      },
    });

    expect(waits).toBe(1);
    expect(env.createCalls).toEqual([]);
    expect(env.storage['pt_notifications']).toBeUndefined();
    expect(env.alarms.size).toBe(0);
    expect(env.fetchCalls).toEqual([]);
    expect(String(warnings[0]?.[0])).toContain('chrome.notifications');
  });

  test('an auto-dismiss alarm that fires while the API is missing is harmless', async () => {
    env.withoutNotificationsPermission();
    init();
    env.fireAlarm('pt-dismiss:1');
    await sleep(10);
    expect(warnings).toEqual([]);
  });

  test('a failing registration after the grant is logged, not thrown', async () => {
    env.withoutNotificationsPermission();
    await init().identify({ id: 'user-1' });
    env.intercept = (call) =>
      call.path === '/v1/subscriptions'
        ? jsonResponse(401, {
            error: { code: 'unauthorized', message: 'invalid key' },
          })
        : undefined;

    env.grantNotifications();
    await sleep(20);

    expect(warnings.length).toBe(1);
    expect(warnings[0][1]).toBeInstanceOf(PushToApiError);
  });

  test('permissions.onRemoved forgets the cached registration without touching pushManager; the next grant registers again', async () => {
    const pushTo = init();
    await pushTo.identify({ id: 'user-1' });
    expect(env.storage['pt_registration']).toBeDefined();
    const callsBefore = env.pushManagerCalls;
    env.fetchCalls.length = 0;

    env.removeNotificationsPermission();
    await sleep(10);

    expect(env.storage['pt_registration']).toBeUndefined();
    expect(env.pushManagerCalls).toBe(callsBefore);
    expect(env.fetchCalls).toEqual([]);
    expect((await pushTo.getState()).registered).toBe(false);
    // The identity is kept: it is what the next grant registers.
    expect(env.storage['pt_identity']).toEqual({ id: 'user-1' });

    env.grantNotifications();
    await sleep(20);
    expect(registrations().map((c) => c.body.external_id)).toEqual(['user-1']);
    expect(env.storage['pt_registration'].externalId).toBe('user-1');
  });
});

describe('identify / reset', () => {
  test('identify without an id rejects with a TypeError and does nothing', async () => {
    const pushTo = init();
    for (const user of [{}, { id: '' }, { id: '   ' }, { email: 'a@b.co' }]) {
      const error = await pushTo.identify(user as any).catch((e) => e);
      expect(error).toBeInstanceOf(TypeError);
      expect(error.message).toContain('user.id');
    }
    const noArgument = await (pushTo as any)
      .identify()
      .catch((e: unknown) => e);
    expect(noArgument).toBeInstanceOf(TypeError);
    expect(env.fetchCalls).toEqual([]);
    expect(env.storage['pt_identity']).toBeUndefined();
  });

  test('identify registers the id; a numeric id is accepted', async () => {
    const result = await init().identify({ id: 'user-1' });
    expect(result).toEqual({
      status: 'registered',
      userId: 42,
      endpointId: 7,
      externalId: 'user-1',
    });

    env.userId = 43;
    const numeric = await init().identify({ id: 7 as any });
    expect(numeric.externalId).toBe('7');
    expect(numeric.userId).toBe(43);
  });

  test('reset posts `anon:<anonymousId>` for the same subscription and drops the remembered identity', async () => {
    const hash = await userHash(IDENTITY_SECRET, 'user-1');
    const pushTo = init();
    await pushTo.identify({ id: 'user-1', hash, email: 'jane@example.com' });
    expect(JSON.stringify(env.session['pt_identity'])).toContain(hash);
    env.userId = 99;

    const result = await pushTo.reset();

    const anonymousId = env.storage['pt_anonymousId'];
    expect(result).toEqual({
      status: 'registered',
      userId: 99,
      endpointId: 7,
      externalId: `anon:${anonymousId}`,
    });
    const [identified, anonymous] = registrations().map((c) => c.body);
    expect(anonymous.external_id).toBe(`anon:${anonymousId}`);
    expect(anonymous.user_hash).toBeUndefined();
    expect(anonymous.email).toBeUndefined();
    // The same browser subscription moves: that is what detaches the user.
    expect(anonymous.subscription).toEqual(identified.subscription);
    expect(env.subscribeCalls.length).toBe(1);

    expect(env.storage['pt_identity']).toEqual({});
    expect(env.session['pt_identity']).toBeUndefined();
    for (const area of [env.storage, env.session]) {
      expect(JSON.stringify(area)).not.toContain(hash);
      expect(JSON.stringify(area)).not.toContain('jane@example.com');
      expect(JSON.stringify(area)).not.toContain('user-1');
    }
  });

  test('registerPushSubscription is the same call: with an id as identify, without a user as reset', async () => {
    const pushTo = init();
    expect(await pushTo.registerPushSubscription({ id: 'user-1' })).toEqual(
      await pushTo.identify({ id: 'user-1' }).then((r) => ({
        ...r,
        status: 'registered',
      })),
    );
    const viaOldName = await pushTo.registerPushSubscription();
    expect(viaOldName.externalId).toMatch(ANON);
    expect((await pushTo.reset()).status).toBe('unchanged');
  });
});

describe('registration result', () => {
  test('`registered`, then `unchanged` with the same ids and no request, also in a new worker', async () => {
    const first = await init().identify({ id: 'user-1' });
    expect(first.status).toBe('registered');
    env.fetchCalls.length = 0;

    env.restartWorker();
    const second = await init().identify({ id: 'user-1' });

    expect(second).toEqual({ ...first, status: 'unchanged' });
    expect(env.fetchCalls).toEqual([]);
  });

  test('a cache entry written by 1.0.0 (no ids) is not trusted once: one registration, then `unchanged` with ids', async () => {
    const pushTo = init();
    await pushTo.reset();
    const { fingerprint, registeredAt } = env.storage['pt_registration'];
    env.storage['pt_registration'] = { fingerprint, registeredAt };
    env.fetchCalls.length = 0;

    const first = await pushTo.reset();
    expect(first.status).toBe('registered');
    expect(first.userId).toBe(42);
    expect(requests()).toEqual(['GET /v1/vapid-key', 'POST /v1/subscriptions']);
    expect(env.subscribeCalls.length).toBe(1); // the subscription is reused
    expect(env.storage['pt_registration'].fingerprint).toBe(fingerprint);

    env.fetchCalls.length = 0;
    const second = await pushTo.reset();
    expect(second).toEqual({ ...first, status: 'unchanged' });
    expect(env.fetchCalls).toEqual([]);
  });

  test('an answer without ids still completes the registration', async () => {
    env.intercept = (call) =>
      call.path === '/v1/subscriptions' ? jsonResponse(200, {}) : undefined;
    const result = await init().identify({ id: 'user-1' });
    expect(result).toEqual({ status: 'registered', externalId: 'user-1' });
    expect((await init().identify({ id: 'user-1' })).status).toBe('unchanged');
  });
});

describe('getState', () => {
  const base = () => ({
    anonymousId: env.storage['pt_anonymousId'],
    apiBaseUrl: `${API_BASE_URL}/v1`,
    sdkVersion: '0.0.0-dev',
  });

  test('before anything, without the permission', async () => {
    env.withoutNotificationsPermission();
    const state = await init().getState();

    expect(state).toEqual({
      permission: 'missing',
      subscribed: false,
      registered: false,
      optedOut: false,
      ...base(),
    });
    expect(state.anonymousId).toMatch(/^[0-9a-f-]{36}$/);
    expect(env.pushManagerCalls).toBe(0);
    expect(env.fetchCalls).toEqual([]);
  });

  test('waiting for the permission: the external id asked for', async () => {
    env.withoutNotificationsPermission();
    const pushTo = init();
    await pushTo.identify({ id: 'user-1' });

    expect(await pushTo.getState()).toEqual({
      permission: 'missing',
      subscribed: false,
      registered: false,
      optedOut: false,
      externalId: 'user-1',
      ...base(),
    });
  });

  test('granted but not registered yet', async () => {
    expect(await init().getState()).toEqual({
      permission: 'granted',
      subscribed: false,
      registered: false,
      optedOut: false,
      ...base(),
    });
  });

  test('registered: ids, external id and time, with no request', async () => {
    const pushTo = init();
    await pushTo.identify({ id: 'user-1' });
    env.fetchCalls.length = 0;

    const state = await pushTo.getState();

    expect(state).toEqual({
      permission: 'granted',
      subscribed: true,
      registered: true,
      optedOut: false,
      userId: 42,
      endpointId: 7,
      externalId: 'user-1',
      registeredAt: new Date(
        env.storage['pt_registration'].registeredAt,
      ).toISOString(),
      ...base(),
    });
    expect(env.fetchCalls).toEqual([]);
  });

  test('a registration over 24 hours old, or made for another subscription, is not `registered`', async () => {
    const pushTo = init();
    await pushTo.identify({ id: 'user-1' });

    env.storage['pt_registration'].registeredAt -= 25 * HOUR;
    expect(await pushTo.getState()).toMatchObject({
      subscribed: true,
      registered: false,
      externalId: 'user-1', // the one asked for
    });
    expect((await pushTo.getState()).userId).toBeUndefined();

    env.storage['pt_registration'].registeredAt += 25 * HOUR;
    expect((await pushTo.getState()).registered).toBe(true);
    // The browser replaced the subscription behind the SDK's back.
    await env.subscription.unsubscribe();
    await (globalThis as any).self.registration.pushManager.subscribe({
      applicationServerKey: new Uint8Array(65),
    });
    expect(await pushTo.getState()).toMatchObject({
      subscribed: true,
      registered: false,
    });
  });

  test('after unsubscribe: opted out, and the identity is still the one asked for', async () => {
    const pushTo = init();
    await pushTo.identify({ id: 'user-1' });
    await pushTo.unsubscribe();

    expect(await pushTo.getState()).toEqual({
      permission: 'granted',
      subscribed: false,
      registered: false,
      optedOut: true,
      deliveryBlocked: 'opted_out',
      externalId: 'user-1',
      ...base(),
    });
  });
});

describe('unsubscribe', () => {
  test('removes the browser subscription, tells push-api, clears the caches and sets the opted-out flag', async () => {
    const hash = await userHash(IDENTITY_SECRET, 'user-1');
    const pushTo = init();
    await pushTo.identify({ id: 'user-1', hash });
    const subscription = registrations()[0].body.subscription;
    env.fetchCalls.length = 0;

    await pushTo.unsubscribe();

    expect(requests()).toEqual(['DELETE /v1/subscriptions']);
    expect(env.fetchCalls[0].body).toEqual({ subscription });
    expect(env.fetchCalls[0].headers.Authorization).toBe('Bearer browser-key');
    expect(env.activeEndpoints.size).toBe(0);
    expect(env.unsubscribeCalls).toBe(1);
    expect(env.subscription).toBeNull();
    // The identity stays: it is what subscribe() registers. Only the id is
    // in chrome.storage.local.
    expect(Object.keys(env.storage).sort()).toEqual([
      'pt_anonymousId',
      'pt_identity',
      'pt_optedOut',
    ]);
    expect(env.storage['pt_identity']).toEqual({ id: 'user-1', details: true });
    expect(JSON.stringify(env.storage)).not.toContain(hash);
    expect(env.storage['pt_optedOut']).toBe(true);
    expect(warnings).toEqual([]);
  });

  test('opted out: neither a permission grant nor identify / reset / registerPushSubscription registers; they resolve `unsubscribed` and touch nothing', async () => {
    const pushTo = init();
    await pushTo.identify({ id: 'user-1' });
    await pushTo.unsubscribe();
    env.fetchCalls.length = 0;
    const pushManagerCalls = env.pushManagerCalls;

    env.grantNotifications();
    await sleep(20);
    // The Quick start's startup call, in this worker and in later ones.
    expect(await pushTo.identify({ id: 'user-1' })).toEqual({
      status: 'unsubscribed',
      externalId: 'user-1',
    });
    env.restartWorker();
    const restarted = init();
    env.grantNotifications();
    env.dispatchMessage({ type: 'pushto:permission-granted' });
    await sleep(20);
    expect((await restarted.identify({ id: 'user-1' })).status).toBe(
      'unsubscribed',
    );
    const anonymous = await restarted.reset();
    expect(anonymous.status).toBe('unsubscribed');
    expect(anonymous.externalId).toMatch(ANON);
    expect((await restarted.registerPushSubscription()).status).toBe(
      'unsubscribed',
    );

    expect(env.fetchCalls).toEqual([]);
    expect(env.pushManagerCalls).toBe(pushManagerCalls);
    expect(env.subscription).toBeNull();
    expect(env.storage['pt_optedOut']).toBe(true);
    expect((await restarted.getState()).optedOut).toBe(true);
  });

  test('subscribe() is what ends the opt-out: it registers the identity last given, also one given while opted out', async () => {
    const pushTo = init();
    await pushTo.identify({ id: 'user-1' });
    await pushTo.unsubscribe();
    env.fetchCalls.length = 0;

    // Turned back on at once: the user that was signed in, not an anonymous one.
    const result = await pushTo.subscribe();
    expect(result).toEqual({
      status: 'registered',
      userId: 42,
      endpointId: 7,
      externalId: 'user-1',
    });
    expect(env.storage['pt_optedOut']).toBeUndefined();
    expect((await pushTo.getState()).optedOut).toBe(false);
    expect((await pushTo.identify({ id: 'user-1' })).status).toBe('unchanged');

    // Another user signs in while opted out; subscribe() registers that one,
    // with the hash that was given.
    await pushTo.unsubscribe();
    const hash = await userHash(IDENTITY_SECRET, 'user-2');
    env.identityRequired = true;
    expect((await pushTo.identify({ id: 'user-2', hash })).status).toBe(
      'unsubscribed',
    );
    env.fetchCalls.length = 0;
    expect((await pushTo.subscribe()).externalId).toBe('user-2');
    expect(registrations()[0].body.user_hash).toBe(hash);
  });

  test('subscribe() without an opt-out registers the remembered identity, or the anonymous subscriber when none was ever given', async () => {
    const first = await init().subscribe();
    expect(first.status).toBe('registered');
    expect(first.externalId).toMatch(ANON);
    expect(env.storage['pt_identity']).toEqual({});

    const pushTo = init();
    await pushTo.identify({ id: 'user-1' });
    expect(await pushTo.subscribe()).toMatchObject({
      status: 'unchanged',
      externalId: 'user-1',
    });

    env.withoutNotificationsPermission();
    env.storage['pt_registration'].registeredAt -= 25 * HOUR;
    expect((await pushTo.subscribe()).status).toBe('permission_required');
  });

  test('the identity is still remembered while opted out, and a change of user still clears the screen', async () => {
    const pushTo = init();
    await pushTo.identify({ id: 'user-1' });
    await env.push({ title: 't', body: 'b', notification_id: 1, data: {} });
    env.subscription.unsubscribe = async () => false; // stays subscribed
    await pushTo.unsubscribe().catch(() => undefined);
    expect(env.active.size).toBe(0);

    await pushTo.reset();
    expect(env.storage['pt_identity']).toEqual({});
    expect(env.storage['pt_optedOut']).toBe(true);
  });

  test('when push-api cannot be reached the browser is unsubscribed all the same, and the promise resolves', async () => {
    const pushTo = init();
    await pushTo.identify({ id: 'user-1' });
    env.fetchCalls.length = 0;
    env.intercept = () => {
      throw new TypeError('Failed to fetch');
    };

    await pushTo.unsubscribe();

    expect(requests()).toEqual([
      'DELETE /v1/subscriptions',
      'DELETE /v1/subscriptions',
      'DELETE /v1/subscriptions',
    ]);
    expect(env.unsubscribeCalls).toBe(1);
    expect(env.subscription).toBeNull();
    expect(env.storage['pt_registration']).toBeUndefined();
    expect(env.storage['pt_vapidKey']).toBeUndefined();
    expect(env.storage['pt_optedOut']).toBe(true);
    expect(warnings.length).toBe(1);
    expect((warnings[0][1] as PushToApiError).code).toBe('network_error');
  });

  test('a refusal from push-api (an older deployment without the route) does not stop it either', async () => {
    const pushTo = init();
    await pushTo.reset();
    env.intercept = (call) =>
      call.method === 'DELETE'
        ? jsonResponse(404, {
            error: { code: 'not_found', message: 'no such route' },
          })
        : undefined;

    await pushTo.unsubscribe();

    expect(env.subscription).toBeNull();
    expect(env.storage['pt_optedOut']).toBe(true);
  });

  test('without a subscription: no request, still opted out', async () => {
    const pushTo = init();
    await pushTo.unsubscribe();
    expect(env.fetchCalls).toEqual([]);
    expect(env.storage['pt_optedOut']).toBe(true);

    // Nor without the permission, where pushManager only fails.
    env.withoutNotificationsPermission();
    await pushTo.unsubscribe();
    expect(env.fetchCalls).toEqual([]);
  });

  test('rejects if the browser does not remove the subscription; the opt-out and the cleanup still hold', async () => {
    const pushTo = init();
    await pushTo.reset();
    env.subscription.unsubscribe = async () => false;

    const error = await pushTo.unsubscribe().catch((e) => e);

    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain('did not remove');
    // push-api was told all the same: it stops sending.
    expect(requests().at(-1)).toBe('DELETE /v1/subscriptions');
    expect(env.activeEndpoints.size).toBe(0);
    expect(env.storage['pt_optedOut']).toBe(true);
    expect(env.storage['pt_registration']).toBeUndefined();
  });

  test('runs in call order with registrations', async () => {
    const pushTo = init();
    const registered = pushTo.identify({ id: 'user-1' });
    const unsubscribed = pushTo.unsubscribe();
    const ignored = pushTo.identify({ id: 'user-2' });
    const subscribed = pushTo.subscribe();
    const results = await Promise.all([
      registered,
      unsubscribed,
      ignored,
      subscribed,
    ]);

    expect(results.map((r) => r?.status)).toEqual([
      'registered',
      undefined,
      'unsubscribed',
      'registered',
    ]);
    expect(
      env.fetchCalls
        .filter((c) => c.path === '/v1/subscriptions')
        .map((c) => `${c.method} ${c.body.external_id ?? ''}`.trim()),
    ).toEqual(['POST user-1', 'DELETE', 'POST user-2']);
    expect(env.storage['pt_optedOut']).toBeUndefined();
  });

  test('the browser subscription is removed before push-api is called, with the keys read beforehand', async () => {
    const pushTo = init();
    await pushTo.reset();
    const subscription = registrations()[0].body.subscription;
    let subscribedWhenDeleteWasSent: boolean | undefined;
    env.intercept = (call) => {
      if (call.method === 'DELETE') {
        subscribedWhenDeleteWasSent = env.subscription !== null;
      }
      return undefined;
    };

    await pushTo.unsubscribe();

    expect(subscribedWhenDeleteWasSent).toBe(false);
    expect(env.fetchCalls.at(-1)?.body).toEqual({ subscription });
    expect(env.activeEndpoints.size).toBe(0);
  });
});

describe('sendTestNotification', () => {
  test('posts the current subscription and resolves to the notification id; the push is displayed and tracked like any other', async () => {
    const pushTo = init();
    await pushTo.identify({ id: 'user-1' });
    const subscription = registrations()[0].body.subscription;
    env.fetchCalls.length = 0;

    const result = await pushTo.sendTestNotification();

    expect(result).toEqual({ notificationId: 9001 });
    expect(requests()).toEqual(['POST /v1/subscriptions/test']);
    expect(env.fetchCalls[0].body).toEqual({ subscription });

    await env.push({
      title: 'Test notification',
      body: 'Push notifications are working in this browser.',
      data: { test: true },
      notification_id: 9001,
    });
    expect(env.active.get('9001')).toMatchObject({
      title: 'Test notification',
      message: 'Push notifications are working in this browser.',
    });
    expect(env.feedbackTypes(9001)).toEqual(['delivered']);
  });

  test('waits for a registration that is still running', async () => {
    const pushTo = init();
    const registered = pushTo.identify({ id: 'user-1' });
    const result = await pushTo.sendTestNotification();
    await registered;
    expect(result.notificationId).toBe(9001);
  });

  test('without a subscription: `subscription_not_found` with no request', async () => {
    const error = await init()
      .sendTestNotification()
      .catch((e) => e);

    expect(error).toBeInstanceOf(PushToApiError);
    expect(error.code).toBe('subscription_not_found');
    expect(error.status).toBe(0);
    expect(error.message).toContain('identify()');
    expect(env.fetchCalls).toEqual([]);
  });

  test('404 `subscription_not_found` from push-api says to register first', async () => {
    const pushTo = init();
    await pushTo.reset();
    env.activeEndpoints.clear(); // push-api disabled it since
    env.fetchCalls.length = 0;

    const error = await pushTo.sendTestNotification().catch((e) => e);

    expect(error).toBeInstanceOf(PushToApiError);
    expect(error.status).toBe(404);
    expect(error.code).toBe('subscription_not_found');
    expect(error.message).toContain('no active subscription');
    expect(error.message).toContain('Register this browser first');
    expect(requests()).toEqual(['POST /v1/subscriptions/test']); // not retried

    // The cached registration is no longer trusted: the next call is sent.
    expect(env.storage['pt_registration']).toBeUndefined();
    expect((await pushTo.reset()).status).toBe('registered');
    expect((await pushTo.sendTestNotification()).notificationId).toBe(9001);
  });

  test('429 `rate_limited` and any other refusal are passed on as they are, without a retry', async () => {
    const pushTo = init();
    await pushTo.reset();
    for (const [status, code] of [
      [429, 'rate_limited'],
      [410, 'subscription_gone'],
      [502, 'push_failed'],
      [401, 'unauthorized'],
    ] as const) {
      env.fetchCalls.length = 0;
      env.intercept = (call) =>
        call.path === '/v1/subscriptions/test'
          ? jsonResponse(status, {
              error: { code, message: `refused: ${code}`, details: { a: 1 } },
            })
          : undefined;

      const error = await pushTo.sendTestNotification().catch((e) => e);

      expect(error).toBeInstanceOf(PushToApiError);
      expect([error.status, error.code, error.message]).toEqual([
        status,
        code,
        `refused: ${code}`,
      ]);
      expect(error.details).toEqual({ a: 1 });
      expect(env.fetchCalls.length).toBe(1);
    }
  });

  test('an answer without a numeric notification_id is `invalid_response`', async () => {
    const pushTo = init();
    await pushTo.reset();
    env.intercept = (call) =>
      call.path === '/v1/subscriptions/test'
        ? jsonResponse(200, { sent: true })
        : undefined;

    const error = await pushTo.sendTestNotification().catch((e) => e);
    expect(error.code).toBe('invalid_response');
  });
});

describe('page helper', () => {
  test('is exported from the main entry and from the page entry', () => {
    expect(publicApi.requestNotificationPermission).toBe(
      pageApi.requestNotificationPermission,
    );
    expect(Object.keys(pageApi)).toEqual(['requestNotificationPermission']);
  });

  test('works without a service-worker global and calls chrome.permissions.request synchronously', async () => {
    // A popup: no ServiceWorkerGlobalScope, no `self.registration`.
    delete (globalThis as any).ServiceWorkerGlobalScope;
    delete (globalThis as any).self;
    const page = await import('../../page');

    const pending = page.requestNotificationPermission();
    // Before anything was awaited: still inside the user gesture.
    expect(env.permissionRequestCalls).toEqual([
      { permissions: ['notifications'] },
    ]);
    expect(await pending).toBe(true);

    env.permissionRequestAnswer = false;
    expect(await page.requestNotificationPermission()).toBe(false);
    expect(env.fetchCalls).toEqual([]);
  });

  test('a throwing or rejecting chrome.permissions.request rejects the promise', async () => {
    (globalThis as any).chrome.permissions.request = () => {
      throw new Error('This function must be called during a user gesture');
    };
    const error = await pageApi.requestNotificationPermission().catch((e) => e);
    expect(error.message).toContain('user gesture');

    delete (globalThis as any).chrome.permissions;
    expect(
      await pageApi.requestNotificationPermission().catch(() => 'rejected'),
    ).toBe('rejected');
  });

  test('the whole flow: the page asks, the worker registers without being told', async () => {
    env.withoutNotificationsPermission();
    const pushTo = init();
    expect((await pushTo.identify({ id: 'user-1' })).status).toBe(
      'permission_required',
    );
    (globalThis as any).chrome.permissions.request = (query: any) => {
      env.permissionRequestCalls.push(query);
      env.grantNotifications();
      return Promise.resolve(true);
    };

    expect(await pageApi.requestNotificationPermission()).toBe(true);
    await sleep(20);

    expect(await pushTo.getState()).toMatchObject({
      permission: 'granted',
      subscribed: true,
      registered: true,
      externalId: 'user-1',
      userId: 42,
    });
  });
});

describe('re-initialisation', () => {
  test('constructing again never duplicates a listener, the permission ones included, before or after the grant', () => {
    env.withoutNotificationsPermission();
    init();
    init({ apiKey: 'second-key' });
    expect(env.permissionsOnAdded.listeners.length).toBe(1);
    expect(env.permissionsOnRemoved.listeners.length).toBe(1);
    expect(notificationListeners()).toEqual({ clicked: 0, closed: 0 });

    env.grantNotifications();
    init();
    init({ apiKey: 'third-key' });
    env.grantNotifications();

    expect(env.pushListeners.length).toBe(1);
    expect(env.actionOnClicked.listeners.length).toBe(1);
    expect(env.alarmsOnAlarm.listeners.length).toBe(1);
    expect(env.permissionsOnAdded.listeners.length).toBe(1);
    expect(env.permissionsOnRemoved.listeners.length).toBe(1);
    expect(notificationListeners()).toEqual({ clicked: 1, closed: 2 });
  });

  test('the registration made on the grant uses the options of the latest instance', async () => {
    env.withoutNotificationsPermission();
    await init().reset();
    init({ apiKey: 'second-key', apiBaseUrl: 'https://second.test' });

    env.grantNotifications();
    await sleep(20);

    expect(registrations().length).toBe(1);
    expect(registrations()[0].url).toBe('https://second.test/v1/subscriptions');
    expect(registrations()[0].headers.Authorization).toBe('Bearer second-key');
  });
});

describe("only the SDK's own notifications", () => {
  /** A notification the extension created itself, with chrome.notifications. */
  const integratorNotification = (id: string) => {
    (globalThis as any).chrome.notifications.create(id, { title: 'mine' });
    env.createCalls.length = 0;
  };

  test('a click on a notification the extension made itself does nothing: not cleared, no tab, no feedback, no storage write', async () => {
    init();
    integratorNotification('my-own');
    const storageBefore = JSON.stringify(env.storage);

    env.click('my-own');
    await sleep(20);

    expect(env.active.has('my-own')).toBe(true);
    expect(env.tabsCreateCalls).toEqual([]);
    expect(env.fetchCalls).toEqual([]);
    expect(env.badgeTextCalls).toEqual([]);
    expect(JSON.stringify(env.storage)).toBe(storageBefore);
    expect(warnings).toEqual([]);

    // And when the user then closes it, that is not a `dismissed`.
    env.userClose('my-own');
    await sleep(20);
    expect(env.fetchCalls).toEqual([]);
    expect(JSON.stringify(env.storage)).toBe(storageBefore);
  });

  test('a close of one, by the user or the system, does nothing, also next to an SDK notification', async () => {
    init();
    await env.push({ title: 't', body: 'b', notification_id: 1, data: {} });
    integratorNotification('my-own');
    env.fetchCalls.length = 0;

    env.userClose('my-own');
    integratorNotification('my-other');
    env.systemClose('my-other');
    await sleep(20);

    expect(env.fetchCalls).toEqual([]);
    expect(Object.keys(env.storage['pt_notifications'])).toEqual(['1']);
    expect(env.active.has('1')).toBe(true);

    // The SDK's own one still works as before.
    env.userClose('1');
    await sleep(20);
    expect(env.feedbackTypes(1)).toEqual(['dismissed']);
  });

  test('an SDK notification shown by an earlier worker is recognised by its stored entry', async () => {
    init();
    await env.push({
      title: 't',
      body: 'b',
      notification_id: 2,
      data: { url: 'https://example.com/a' },
    });
    integratorNotification('my-own');
    env.restartWorker();
    init();

    env.click('my-own');
    env.click('2');
    await sleep(20);

    expect(env.active.has('my-own')).toBe(true);
    expect(env.active.has('2')).toBe(false);
    expect(env.tabsCreateCalls).toEqual([{ url: 'https://example.com/a' }]);
    expect(env.feedbackTypes(2)).toEqual(['delivered', 'clicked', 'opened']);
  });

  test("an SDK notification whose state could not be stored is still the SDK's in the worker that showed it", async () => {
    init();
    env.storageSetError = 'QUOTA_BYTES quota exceeded';
    await env.push({ title: 't', body: 'b', notification_id: 3, data: {} });
    expect(env.active.has('3')).toBe(true);

    env.click('3');
    await sleep(20);
    expect(env.active.has('3')).toBe(false);
  });

  test("an unreadable (garbage) stored entry still marks the id as the SDK's", async () => {
    env.storage['pt_notifications'] = { broken: 'garbage' };
    env.active.set('broken', {});
    init();

    env.click('broken');
    await sleep(20);

    expect(env.active.has('broken')).toBe(false);
    expect(env.storage['pt_notifications']).toEqual({});
  });
});

describe("only the SDK's own badge", () => {
  const toolbarClick = async () => {
    env.actionOnClicked.listeners.forEach((l) => l());
    await sleep(10);
  };

  test('a badge the extension set itself is not cleared by the toolbar click or by a notification click', async () => {
    init();
    await toolbarClick();
    await env.push({
      title: 't',
      body: 'b',
      notification_id: 1,
      data: { url: 'https://example.com' },
    });
    env.click('1');
    await sleep(20);
    await toolbarClick();

    expect(env.badgeTextCalls).toEqual([]);
    expect(env.storage['pt_badge']).toBeUndefined();
  });

  test("the SDK's badge is cleared by the toolbar click, once: a later badge of the extension is left alone", async () => {
    init();
    await env.push({
      title: 't',
      body: 'b',
      notification_id: 1,
      data: { badge: { text: '3', color: '#f00' } },
    });
    expect(env.badgeTextCalls).toEqual(['3']);
    expect(env.storage['pt_badge']).toBe(true);

    await toolbarClick();
    expect(env.badgeTextCalls).toEqual(['3', '']);
    expect(env.storage['pt_badge']).toBeUndefined();

    // The extension sets its own badge now; nothing of the SDK clears it.
    await toolbarClick();
    env.click('1');
    await sleep(20);
    expect(env.badgeTextCalls).toEqual(['3', '']);
  });

  test("the SDK's badge is cleared by a click on its notification, also in a later worker", async () => {
    init();
    await env.push({
      title: 't',
      body: 'b',
      notification_id: 1,
      data: { badge: { text: '1' } },
    });
    env.restartWorker();
    init();

    env.click('1');
    await sleep(20);

    expect(env.badgeTextCalls).toEqual(['1', '']);
    expect(env.storage['pt_badge']).toBeUndefined();
  });

  test('when the marker cannot be stored the badge is not set at all', async () => {
    init();
    env.storageSetError = 'QUOTA_BYTES quota exceeded';
    await env.push({
      title: 't',
      body: 'b',
      notification_id: 1,
      data: { badge: { text: '1' } },
    });
    expect(env.active.has('1')).toBe(true);
    expect(env.badgeTextCalls).toEqual([]);
  });
});

describe('reset / unsubscribe clear what the SDK has on screen', () => {
  const show = async () => {
    await env.push({
      title: 'a',
      body: 'b',
      notification_id: 1,
      data: { badge: { text: '2' } },
    });
    await env.push({
      title: 'a',
      body: 'b',
      notification_id: 2,
      data: { auto_dismiss: { behavior: 'timed', dismiss_time_ms: 120_000 } },
    });
    (globalThis as any).chrome.notifications.create('my-own', {
      title: 'mine',
    });
    expect(env.alarms.size).toBe(1);
  };
  const expectCleared = () => {
    expect([...env.active.keys()]).toEqual(['my-own']);
    expect(env.storage['pt_notifications']).toEqual({});
    expect(env.alarms.size).toBe(0);
    expect(env.badgeTextCalls).toEqual(['2', '']);
    expect(env.storage['pt_badge']).toBeUndefined();
    // Silently: nothing but the two `delivered`.
    expect(env.feedback().map((c) => c.body.event_type)).toEqual([
      'delivered',
      'delivered',
    ]);
  };

  test("reset after identify: notifications, stored state, alarms and badge are gone; the extension's own notification stays; no `dismissed`", async () => {
    const pushTo = init();
    await pushTo.identify({ id: 'user-1' });
    await show();

    await pushTo.reset();
    await sleep(20);

    expectCleared();
  });

  test('it does not depend on the registration succeeding (offline sign-out)', async () => {
    const pushTo = init();
    await pushTo.identify({ id: 'user-1' });
    await show();
    env.intercept = (call) => {
      if (call.path !== '/v1/feedback') {
        throw new TypeError('Failed to fetch');
      }
      return undefined;
    };

    expect(await pushTo.reset().catch((e) => e.code)).toBe('network_error');
    await sleep(20);

    expectCleared();
  });

  test('identify for another user clears them too; the same user again, or signing in from anonymous, does not', async () => {
    const pushTo = init();
    await pushTo.reset();
    await show();

    await pushTo.reset(); // every worker start of a signed-out user
    await pushTo.identify({ id: 'user-1' }); // sign-in
    await pushTo.identify({ id: 'user-1' }); // every worker start
    await pushTo.identify({ id: ' user-1 ', email: 'a@b.co' });
    await sleep(20);
    expect(env.active.size).toBe(3);
    expect(env.badgeTextCalls).toEqual(['2']);

    await pushTo.identify({ id: 'user-2' });
    await sleep(20);
    expectCleared();
  });

  test('unsubscribe clears them, whoever is signed in', async () => {
    const pushTo = init();
    await pushTo.reset();
    await show();

    await pushTo.unsubscribe();
    await sleep(20);

    expectCleared();
  });

  test('with nothing on screen and no SDK badge, nothing is touched', async () => {
    const pushTo = init();
    await pushTo.identify({ id: 'user-1' });
    (globalThis as any).chrome.notifications.create('my-own', {
      title: 'mine',
    });

    await pushTo.reset();
    await pushTo.unsubscribe();
    await sleep(20);

    expect(env.active.has('my-own')).toBe(true);
    expect(env.badgeTextCalls).toEqual([]);
  });
});

describe('pushes are not displayed while they cannot be for the person at the browser', () => {
  const push = (id: number) =>
    env.push({ title: 't', body: 'b', notification_id: id, data: {} });
  const offline = () => {
    env.intercept = (call) => {
      if (call.path !== '/v1/feedback') {
        throw new TypeError('Failed to fetch');
      }
      return undefined;
    };
  };

  test('after a sign-out the API has not confirmed, a push (for the previous user) shows nothing and reports nothing; once confirmed, pushes are shown again', async () => {
    const pushTo = init();
    await pushTo.identify({ id: 'user-1' });
    await push(1);
    expect(env.active.has('1')).toBe(true);

    offline();
    await pushTo.reset().catch(() => undefined);
    expect(env.active.size).toBe(0);
    env.fetchCalls.length = 0;

    expect(await push(2)).toBe(1);
    env.restartWorker();
    init();
    await push(3);
    expect(env.createCalls.map((c) => c.id)).toEqual(['1']);
    expect(env.fetchCalls).toEqual([]);
    expect(env.storage['pt_notifications']).toEqual({});
    expect(String(warnings.at(-1)?.[0])).toContain('change of user');

    env.intercept = undefined;
    expect((await init().reset()).status).toBe('registered');
    await push(4);
    expect(env.active.has('4')).toBe(true);
    expect(env.feedbackTypes(4)).toEqual(['delivered']);
  });

  test('a switch to another user is gated the same way while it is in flight', async () => {
    const pushTo = init();
    await pushTo.identify({ id: 'user-1' });
    let release: () => void = () => undefined;
    env.intercept = async (call) => {
      if (call.path === '/v1/subscriptions') {
        await new Promise<void>((resolve) => (release = resolve));
      }
      return undefined;
    };

    const switching = pushTo.identify({ id: 'user-2' });
    await sleep(10);
    await push(1);
    expect(env.createCalls).toEqual([]);

    release();
    await switching;
    await push(2);
    expect(env.active.has('2')).toBe(true);
  });

  test('a notification of the previous user that reached the screen while the sign-out was pending is cleared when a later reset succeeds', async () => {
    const pushTo = init();
    await pushTo.identify({ id: 'user-1' });
    offline();
    await pushTo.reset().catch(() => undefined);

    // One that was already past the gate when the sign-out was asked for.
    env.storage['pt_notifications'] = {
      '9': {
        v: 2,
        id: '9',
        notificationId: 9,
        title: 'for user-1',
        message: '',
      },
    };
    env.active.set('9', {});

    // The later call sees no change of the remembered identity…
    env.intercept = undefined;
    env.restartWorker();
    expect((await init().reset()).status).toBe('registered');
    await sleep(20);

    // …but the registration moved away from user-1.
    expect(env.active.size).toBe(0);
    expect(env.storage['pt_notifications']).toEqual({});
    expect(env.feedback().map((c) => c.body.event_type)).toEqual([]);
  });

  test('signing in from the anonymous subscriber clears nothing when it is confirmed', async () => {
    const pushTo = init();
    await pushTo.reset();
    await push(1);
    await pushTo.identify({ id: 'user-1' });
    await sleep(20);
    expect(env.active.has('1')).toBe(true);
  });

  test('the gate is not applied when either side is unknown: a 1.0.0 cache entry, or no identity ever asked for', async () => {
    const pushTo = init();
    await pushTo.identify({ id: 'user-1' });
    const { fingerprint, registeredAt } = env.storage['pt_registration'];

    env.storage['pt_registration'] = { fingerprint, registeredAt };
    env.storage['pt_identity'] = { id: 'someone-else' };
    await push(1);
    expect(env.active.has('1')).toBe(true);

    env.storage['pt_registration'] = {
      fingerprint,
      registeredAt,
      externalId: 'user-1',
    };
    delete env.storage['pt_identity'];
    await push(2);
    expect(env.active.has('2')).toBe(true);
  });

  test('opted out: a push is not displayed or reported, whether the subscription could not be removed or could not be reached; subscribe() lifts it', async () => {
    // 1. The browser refuses to remove the subscription.
    const pushTo = init();
    await pushTo.identify({ id: 'user-1' });
    env.subscription.unsubscribe = async () => false;
    await pushTo.unsubscribe().catch(() => undefined);
    env.fetchCalls.length = 0;

    await push(1);
    expect(env.createCalls).toEqual([]);
    expect(env.fetchCalls).toEqual([]);
    expect(String(warnings.at(-1)?.[0])).toContain('unsubscribe()');

    // 2. Unsubscribed while the permission was missing: pushManager cannot
    // be reached, the subscription survives, and the permission comes back.
    await pushTo.subscribe();
    env.removeNotificationsPermission();
    await sleep(10);
    env.fetchCalls.length = 0;
    await pushTo.unsubscribe();
    expect(env.fetchCalls).toEqual([]);
    expect(env.subscription).not.toBeNull();
    env.grantNotifications();
    await sleep(20);
    env.restartWorker();
    const restarted = init();

    await push(2);
    expect(env.createCalls).toEqual([]);
    expect(env.fetchCalls).toEqual([]);

    await restarted.subscribe();
    await push(3);
    expect(env.active.has('3')).toBe(true);
  });

  test('a state that cannot be read does not cost the notification', async () => {
    init();
    const get = (globalThis as any).chrome.storage.local.get;
    (globalThis as any).chrome.storage.local.get = async (key: string) => {
      if (key === 'pt_optedOut') {
        throw new Error('storage unavailable');
      }
      return get(key);
    };
    await push(1);
    expect(env.active.has('1')).toBe(true);
  });
});

describe('the identity proof stays out of chrome.storage.local', () => {
  test('hash, email, name, imageUrl and language are kept in session storage only', async () => {
    const hash = await userHash(IDENTITY_SECRET, 'user-1');
    await init().identify({
      id: 'user-1',
      hash,
      email: 'jane@example.com',
      name: 'Jane Doe',
      imageUrl: 'https://example.com/jane.png',
      language: 'pt',
    });

    const onDisk = JSON.stringify(env.storage);
    for (const value of [hash, 'jane@example.com', 'Jane', 'jane.png']) {
      expect(onDisk).not.toContain(value);
    }
    expect(env.storage['pt_identity']).toEqual({ id: 'user-1', details: true });
    expect(env.session['pt_identity'].user.hash).toBe(hash);
  });

  test('after a browser restart the grant does not register an identity whose hash is gone; the startup identify does', async () => {
    env.withoutNotificationsPermission();
    env.identityRequired = true;
    const hash = await userHash(IDENTITY_SECRET, 'user-1');
    await init().identify({ id: 'user-1', hash });

    env.restartBrowser();
    const pushTo = init();
    env.grantNotifications();
    await sleep(20);
    expect(env.fetchCalls).toEqual([]);
    expect(env.pushManagerCalls).toBe(0);
    expect((await pushTo.getState()).externalId).toBe('user-1');

    const result = await pushTo.identify({ id: 'user-1', hash });
    expect(result.status).toBe('registered');
    expect(registrations()[0].body.user_hash).toBe(hash);
  });

  test('a worker restart keeps it: the grant registers with the hash', async () => {
    env.withoutNotificationsPermission();
    env.identityRequired = true;
    const hash = await userHash(IDENTITY_SECRET, 'user-1');
    await init().identify({ id: 'user-1', hash });

    env.restartWorker();
    init();
    env.grantNotifications();
    await sleep(20);

    expect(registrations().map((c) => c.body.user_hash)).toEqual([hash]);
  });

  test('an identity given as an id only, or an anonymous one, loses nothing and is registered on the grant after a browser restart', async () => {
    env.withoutNotificationsPermission();
    await init().identify({ id: 'user-1' });
    env.restartBrowser();
    init();
    env.grantNotifications();
    await sleep(20);
    expect(registrations().map((c) => c.body.external_id)).toEqual(['user-1']);
  });

  test('without chrome.storage.session the fields live in memory: used in the same worker, gone with it', async () => {
    delete (globalThis as any).chrome.storage.session;
    env.withoutNotificationsPermission();
    const hash = await userHash(IDENTITY_SECRET, 'user-1');
    await init().identify({ id: 'user-1', hash });
    expect(JSON.stringify(env.storage)).not.toContain(hash);

    env.restartWorker();
    init();
    env.grantNotifications();
    await sleep(20);
    expect(env.fetchCalls).toEqual([]); // the hash is gone: wait for identify

    env.withoutNotificationsPermission();
    await init().identify({ id: 'user-1', hash });
    env.grantNotifications();
    await sleep(20);
    expect(registrations().map((c) => c.body.user_hash)).toEqual([hash]);
  });

  test('details of another identity are never used', async () => {
    env.withoutNotificationsPermission();
    const hash = await userHash(IDENTITY_SECRET, 'user-1');
    const pushTo = init();
    await pushTo.identify({ id: 'user-1', hash });
    // A stale session entry next to a newer id on disk.
    env.storage['pt_identity'] = { id: 'user-2', details: true };

    env.grantNotifications();
    await sleep(20);
    expect(env.fetchCalls).toEqual([]);
  });
});

describe('the grant message from the page (when permissions.onAdded does not reach the worker)', () => {
  const GRANTED = { type: 'pushto:permission-granted' };

  test('one listener, added at top level, however often the SDK is constructed', () => {
    init();
    init({ apiKey: 'second' });
    expect(env.runtimeOnMessage.listeners.length).toBe(1);
  });

  test('a grant without onAdded: the message attaches the listeners and registers once', async () => {
    env.withoutNotificationsPermission();
    await init().identify({ id: 'user-1' });

    env.grantNotifications({ fireEvent: false });
    const { returned, responded } = env.dispatchMessage(GRANTED);
    expect(returned).toEqual([undefined]);
    expect(responded).toBe(false);
    expect(notificationListeners()).toEqual({ clicked: 1, closed: 2 });
    await sleep(20);

    expect(registrations().map((c) => c.body.external_id)).toEqual(['user-1']);
  });

  test('onAdded and the message both arrive: one registration, no duplicate listener', async () => {
    env.withoutNotificationsPermission();
    await init().identify({ id: 'user-1' });

    env.grantNotifications();
    env.dispatchMessage(GRANTED);
    env.dispatchMessage(GRANTED);
    await sleep(30);

    expect(registrations().length).toBe(1);
    expect(notificationListeners()).toEqual({ clicked: 1, closed: 2 });
  });

  test("any other message, and the SDK's message from another sender, is ignored: undefined is returned, nothing is answered, nothing happens", async () => {
    env.withoutNotificationsPermission();
    await init().identify({ id: 'user-1' });
    env.grantNotifications({ fireEvent: false, exposeApi: false });

    for (const [message, sender] of [
      [{ type: 'my-app:something' }, 'ext-test-id'],
      [{ type: 'pushto:permission-granted ' }, 'ext-test-id'],
      ['pushto:permission-granted', 'ext-test-id'],
      [null, 'ext-test-id'],
      [undefined, 'ext-test-id'],
      [42, 'ext-test-id'],
      [GRANTED, 'another-extension-id'],
      [GRANTED, null],
    ] as const) {
      const { returned, responded } = env.dispatchMessage(message, sender);
      expect(returned).toEqual([undefined]);
      expect(responded).toBe(false);
    }
    await sleep(20);

    expect(env.fetchCalls).toEqual([]);
    expect(env.pushManagerCalls).toBe(0);
  });

  test('requestNotificationPermission sends it after a grant, after having called permissions.request synchronously', async () => {
    const pending = pageApi.requestNotificationPermission();
    expect(env.permissionRequestCalls.length).toBe(1);
    expect(env.sentMessages).toEqual([]);
    expect(await pending).toBe(true);
    expect(env.sentMessages).toEqual([GRANTED]);
  });

  test('nothing is sent when the user declines; a worker that does not answer, or a missing runtime, does not fail the helper', async () => {
    env.permissionRequestAnswer = false;
    expect(await pageApi.requestNotificationPermission()).toBe(false);
    expect(env.sentMessages).toEqual([]);

    env.permissionRequestAnswer = true;
    env.deliverMessages = false; // "Receiving end does not exist"
    expect(await pageApi.requestNotificationPermission()).toBe(true);
    await sleep(5);

    (globalThis as any).chrome.runtime.sendMessage = () => {
      throw new Error('Extension context invalidated.');
    };
    expect(await pageApi.requestNotificationPermission()).toBe(true);
    delete (globalThis as any).chrome.runtime;
    expect(await pageApi.requestNotificationPermission()).toBe(true);
  });

  test('end to end without onAdded: the page asks, the message reaches the worker, the worker registers', async () => {
    env.withoutNotificationsPermission();
    const pushTo = init();
    await pushTo.identify({ id: 'user-1' });
    (globalThis as any).chrome.permissions.request = () => {
      env.grantNotifications({ fireEvent: false });
      return Promise.resolve(true);
    };

    expect(await pageApi.requestNotificationPermission()).toBe(true);
    await sleep(20);

    expect(await pushTo.getState()).toMatchObject({
      permission: 'granted',
      registered: true,
      externalId: 'user-1',
    });
  });
});

describe('second review: smaller points', () => {
  test('without chrome.permissions the presence of chrome.notifications decides the registration', async () => {
    delete (globalThis as any).chrome.permissions;
    expect((await init().identify({ id: 'user-1' })).status).toBe('registered');

    delete (globalThis as any).chrome.notifications;
    env.storage['pt_registration'].registeredAt -= 25 * HOUR;
    expect((await init().identify({ id: 'user-1' })).status).toBe(
      'permission_required',
    );
  });

  test("a click or a close of the extension's own notification whose id names an Object.prototype member is ignored", async () => {
    init();
    await env.push({ title: 't', body: 'b', notification_id: 1, data: {} });
    env.fetchCalls.length = 0;
    const before = JSON.stringify(env.storage);

    for (const id of [
      '__proto__',
      'constructor',
      'toString',
      'hasOwnProperty',
    ]) {
      env.active.set(id, {});
      env.click(id);
      await sleep(10);
      expect(env.active.has(id)).toBe(true);
      env.userClose(id);
      await sleep(10);
    }

    expect(env.fetchCalls).toEqual([]);
    expect(env.tabsCreateCalls).toEqual([]);
    expect(JSON.stringify(env.storage)).toBe(before);
    expect(warnings).toEqual([]);
  });

  test('sendTestNotification is not retried: a lost answer must not turn into a cooldown error', async () => {
    const pushTo = init();
    await pushTo.reset();
    env.fetchCalls.length = 0;
    env.intercept = () => {
      throw new TypeError('Failed to fetch');
    };

    const error = await pushTo.sendTestNotification().catch((e) => e);

    expect(error.code).toBe('network_error');
    expect(env.fetchCalls.length).toBe(1);

    env.intercept = () =>
      jsonResponse(503, { error: { code: 'busy', message: 'busy' } });
    env.fetchCalls.length = 0;
    expect((await pushTo.sendTestNotification().catch((e) => e)).code).toBe(
      'busy',
    );
    expect(env.fetchCalls.length).toBe(1);
  });

  test('sendTestNotification without the permission says that the permission is missing', async () => {
    env.withoutNotificationsPermission();
    const error = await init()
      .sendTestNotification()
      .catch((e) => e);
    expect(error.code).toBe('subscription_not_found');
    expect(error.status).toBe(0);
    expect(error.message).toContain('`notifications` permission');
    expect(env.fetchCalls).toEqual([]);
  });

  test('429 carries the scope and the wait of push-api untouched', async () => {
    const pushTo = init();
    await pushTo.reset();
    for (const scope of ['address', 'tenant']) {
      env.intercept = (call) =>
        call.path === '/v1/subscriptions/test'
          ? jsonResponse(429, {
              error: {
                code: 'rate_limited',
                message: 'too many test notifications',
                details: { retry_after: 12, scope },
              },
            })
          : undefined;
      const error = await pushTo.sendTestNotification().catch((e) => e);
      expect(error.details).toEqual({ retry_after: 12, scope });
    }
  });

  test('a sign-out also clears a notification this worker showed but could not store, and one failing id does not keep the others', async () => {
    const pushTo = init();
    await pushTo.identify({ id: 'user-1' });
    await env.push({ title: 't', body: 'b', notification_id: 1, data: {} });
    env.storageSetError = 'QUOTA_BYTES quota exceeded';
    await env.push({ title: 't', body: 'b', notification_id: 2, data: {} });
    env.storageSetError = undefined;
    await env.push({ title: 't', body: 'b', notification_id: 3, data: {} });
    expect([...env.active.keys()]).toEqual(['1', '2', '3']);

    // Clearing the alarm of the first one fails.
    const clear = (globalThis as any).chrome.alarms.clear;
    (globalThis as any).chrome.alarms.clear = async (name: string) => {
      if (name.endsWith(':1')) {
        throw new Error('alarms unavailable');
      }
      return clear(name);
    };

    await pushTo.reset();
    await sleep(20);

    expect(env.active.size).toBe(0);
  });

  test('unsubscribe removes both caches with one storage call', async () => {
    const pushTo = init();
    await pushTo.reset();
    const removed: unknown[] = [];
    const remove = (globalThis as any).chrome.storage.local.remove;
    (globalThis as any).chrome.storage.local.remove = async (keys: unknown) => {
      removed.push(keys);
      return remove(keys);
    };

    await pushTo.unsubscribe();

    expect(removed).toContainEqual(['pt_registration', 'pt_vapidKey']);
  });
});

describe('third review', () => {
  test('if PushSubscription.unsubscribe() throws, push-api is still told, and the error is rethrown', async () => {
    const pushTo = init();
    await pushTo.reset();
    const subscription = registrations()[0].body.subscription;
    const failure = new DOMException(
      'push service unreachable',
      'NetworkError',
    );
    env.subscription.unsubscribe = async () => {
      throw failure;
    };
    env.fetchCalls.length = 0;

    const error = await pushTo.unsubscribe().catch((e) => e);

    expect(error).toBe(failure);
    expect(requests()).toEqual(['DELETE /v1/subscriptions']);
    expect(env.fetchCalls[0].body).toEqual({ subscription });
    expect(env.activeEndpoints.size).toBe(0);
    expect(env.storage['pt_optedOut']).toBe(true);
    expect(env.storage['pt_registration']).toBeUndefined();
  });

  test('getState().deliveryBlocked: absent normally, `identity_change_pending` while identify keeps being refused, `opted_out` after unsubscribe', async () => {
    const pushTo = init();
    expect('deliveryBlocked' in (await pushTo.getState())).toBe(false);
    await pushTo.reset();
    expect('deliveryBlocked' in (await pushTo.getState())).toBe(false);

    // A wrong hash: the sign-in is never confirmed.
    const refused = await pushTo
      .identify({ id: 'user-1', hash: 'f'.repeat(64) })
      .catch((e) => e);
    expect(refused.code).toBe('invalid_user_hash');
    expect((await pushTo.getState()).deliveryBlocked).toBe(
      'identity_change_pending',
    );
    await env.push({ title: 't', body: 'b', notification_id: 1, data: {} });
    expect(env.createCalls).toEqual([]);

    await pushTo.identify({
      id: 'user-1',
      hash: await userHash(IDENTITY_SECRET, 'user-1'),
    });
    expect('deliveryBlocked' in (await pushTo.getState())).toBe(false);

    await pushTo.unsubscribe();
    expect((await pushTo.getState()).deliveryBlocked).toBe('opted_out');
    await pushTo.subscribe();
    expect('deliveryBlocked' in (await pushTo.getState())).toBe(false);
  });
});
