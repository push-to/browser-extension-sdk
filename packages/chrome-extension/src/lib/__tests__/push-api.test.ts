/**
 * The SDK against a fake push-api: registration, the fetch wrapper, payload
 * handling, the display contract and feedback. Mocked environment in
 * ./test-env.ts; no network.
 *
 * Run: bun test src/lib/__tests__/push-api.test.ts
 * (run from packages/chrome-extension)
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { ApiClient, PushToApiError, resolveApiBaseUrl } from '../api-client';
import { FALLBACK_ICON, normalizePayload, safeHttpUrl } from '../payload';
import { PushNotifications } from '../pushto-chrome-extension';
import { toUserBody } from '../register-subscription';
import * as publicApi from '../../index';
import {
  API_BASE_URL,
  IDENTITY_SECRET,
  installMocks,
  jsonResponse,
  resetSingletons,
  sleep,
  TestEnv,
  userHash,
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

const calls = (method: string, path: string | RegExp) =>
  env.fetchCalls.filter(
    (c) =>
      c.method === method &&
      (typeof path === 'string' ? c.path === path : path.test(c.path)),
  );

describe('public surface', () => {
  test('the package exports the class and the error class', () => {
    expect(publicApi.PushNotifications).toBe(PushNotifications);
    expect(publicApi.PushToApiError).toBe(PushToApiError);
    expect(
      new PushToApiError({ status: 1, code: 'c', message: 'm' }),
    ).toBeInstanceOf(Error);
  });
});

describe('base URL', () => {
  test('the option overrides the build-time host; /v1 is appended; trailing slashes are normalised', () => {
    expect(resolveApiBaseUrl(undefined, 'https://core.test')).toBe(
      'https://core.test/v1',
    );
    expect(resolveApiBaseUrl('https://other.test', 'https://core.test')).toBe(
      'https://other.test/v1',
    );
    expect(
      resolveApiBaseUrl('https://other.test///', 'https://core.test'),
    ).toBe('https://other.test/v1');
    expect(resolveApiBaseUrl('  https://other.test/base/ ', '')).toBe(
      'https://other.test/base/v1',
    );
    expect(resolveApiBaseUrl('', 'https://core.test/')).toBe(
      'https://core.test/v1',
    );
    // A host that already carries /v1 is not doubled.
    expect(resolveApiBaseUrl('https://other.test/v1/', '')).toBe(
      'https://other.test/v1',
    );
    expect(resolveApiBaseUrl('http://127.0.0.1:3000', '')).toBe(
      'http://127.0.0.1:3000/v1',
    );
  });

  test('no usable host is an error, at construction', () => {
    // '' stands for a build without PUSHTO_CORE_URL (`undefined` would mean
    // "use the build-time host").
    expect(() => resolveApiBaseUrl(undefined, '')).toThrow(/apiBaseUrl/);
    expect(() => resolveApiBaseUrl('  ', '')).toThrow(/apiBaseUrl/);
    expect(() => resolveApiBaseUrl('not a url', '')).toThrow(/apiBaseUrl/);
    expect(() => resolveApiBaseUrl('ftp://x.test', '')).toThrow(/apiBaseUrl/);
    expect(
      () => new PushNotifications({ apiKey: 'k', apiBaseUrl: 'nope' }),
    ).toThrow(/apiBaseUrl/);
  });

  test('requests go to {apiBaseUrl}/v1 with the bearer key and a JSON content type', async () => {
    await init({
      apiBaseUrl: 'https://tenant.test/',
    }).registerPushSubscription();

    expect(env.fetchCalls.map((c) => c.url)).toEqual([
      'https://tenant.test/v1/vapid-key',
      'https://tenant.test/v1/subscriptions',
    ]);
    for (const call of env.fetchCalls) {
      expect(call.headers).toEqual({
        'Content-Type': 'application/json',
        Authorization: 'Bearer browser-key',
      });
    }
  });
});

const registrations = () => calls('POST', '/v1/subscriptions');

const conflict = () =>
  jsonResponse(409, {
    error: {
      code: 'endpoint_conflict',
      message: 'this endpoint is registered to another user',
    },
  });

describe('registration — POST /v1/subscriptions', () => {
  test('anonymous: one call, `anon:<uuid>` external id, the subscription and the metadata', async () => {
    await init().registerPushSubscription();

    expect(env.fetchCalls.map((c) => `${c.method} ${c.path}`)).toEqual([
      'GET /v1/vapid-key',
      'POST /v1/subscriptions',
    ]);

    const anonymousId = env.storage['pt_anonymousId'];
    // The shape push-api exempts from identity verification.
    expect(`anon:${anonymousId}`).toMatch(
      /^anon:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(registrations()[0].body).toEqual({
      external_id: `anon:${anonymousId}`,
      subscription: {
        endpoint: 'https://fcm.googleapis.com/fcm/send/sub-1',
        expirationTime: null,
        keys: { p256dh: 'p256dh-1', auth: 'auth-1' },
      },
      metadata: {
        channel: 'extension',
        extension_id: 'ext-test-id',
        browser_language: 'pt-BR',
        context_url: 'chrome-extension://ext-test-id/',
        sdk_version: '0.0.0-dev',
        anonymous_id: anonymousId,
      },
    });
    expect(Object.keys(env.storage['pt_registration']).sort()).toEqual([
      'endpointId',
      'externalId',
      'fingerprint',
      'registeredAt',
      'subscriptionHash',
      'userId',
    ]);
    // The address and the keys themselves are not stored, only their hash.
    expect(JSON.stringify(env.storage)).not.toContain('p256dh-1');
    expect(JSON.stringify(env.storage)).not.toContain('auth-1');
    expect(JSON.stringify(env.storage)).not.toContain('fcm.googleapis.com');
    expect(env.storage['pt_registration'].fingerprint).toMatch(
      /^[0-9a-f]{64}$/,
    );
    // Neither the key nor the user is readable from what is stored.
    expect(JSON.stringify(env.storage)).not.toContain('browser-key');
  });

  test('identified: id → external_id, name split, imageUrl/language → subscription metadata, never properties/preferences', async () => {
    await init().registerPushSubscription({
      id: 'user-123',
      email: 'jane@example.com',
      name: 'Jane  van der Berg',
      imageUrl: 'https://example.com/jane.png',
      language: 'nl',
    });

    const { subscription, metadata, ...user } = registrations()[0].body;
    expect(user).toEqual({
      external_id: 'user-123',
      email: 'jane@example.com',
      first_name: 'Jane',
      last_name: 'van der Berg',
    });
    expect(subscription.endpoint).toMatch(/sub-1$/);
    expect(metadata.image_url).toBe('https://example.com/jane.png');
    expect(metadata.language).toBe('nl');
    expect(metadata.anonymous_id).toBe(env.storage['pt_anonymousId']);
  });

  test('user mapping omits absent and empty fields instead of sending "" or null', () => {
    expect(toUserBody(undefined, 'a1')).toEqual({ external_id: 'anon:a1' });
    expect(toUserBody({}, 'a1')).toEqual({ external_id: 'anon:a1' });
    expect(toUserBody({ id: '  ', email: '', name: '   ' }, 'a1')).toEqual({
      external_id: 'anon:a1',
    });
    expect(toUserBody({ email: 'a@b.co' }, 'a1')).toEqual({
      external_id: 'anon:a1',
      email: 'a@b.co',
    });
    expect(toUserBody({ id: 'u', name: 'Cher' }, 'a1')).toEqual({
      external_id: 'u',
      first_name: 'Cher',
    });
    expect(toUserBody({ id: 'u', name: '  Ada\tLovelace ' }, 'a1')).toEqual({
      external_id: 'u',
      first_name: 'Ada',
      last_name: 'Lovelace',
    });
    expect(
      JSON.stringify(
        toUserBody({ id: 'u', name: null as any, email: null as any }, 'a1'),
      ),
    ).toBe('{"external_id":"u"}');
  });

  test('no request goes to /v1/users any more, and the answer is not read', async () => {
    env.intercept = (call) =>
      call.path === '/v1/subscriptions' ? jsonResponse(200, {}) : undefined;

    await init().registerPushSubscription();
    await init().registerPushSubscription({ id: 'user-1', name: 'A B' });

    expect(registrations().length).toBe(2);
    expect(env.fetchCalls.filter((c) => c.path.includes('/users'))).toEqual([]);
    expect(env.storage['pt_registration'].fingerprint).toMatch(
      /^[0-9a-f]{64}$/,
    );
  });

  test('`hash` is sent as `user_hash` next to an id, and never for an anonymous registration', async () => {
    const hash = await userHash(IDENTITY_SECRET, 'user-1');
    expect(toUserBody({ id: 'u', hash }, 'a1')).toEqual({
      external_id: 'u',
      user_hash: hash,
    });
    expect(toUserBody({ id: 7, hash: ` ${hash}\n` }, 'a1')).toEqual({
      external_id: '7',
      user_hash: hash,
    });
    for (const noHash of ['', '   ', undefined, null, 42, {}]) {
      expect(toUserBody({ id: 'u', hash: noHash as any }, 'a1')).toEqual({
        external_id: 'u',
      });
    }
    // No id: the hash proves nothing about an anonymous id.
    expect(toUserBody({ hash }, 'a1')).toEqual({ external_id: 'anon:a1' });
    expect(toUserBody({ id: '  ', hash, email: 'a@b.co' }, 'a1')).toEqual({
      external_id: 'anon:a1',
      email: 'a@b.co',
    });

    await init().registerPushSubscription({ id: 'user-1', hash });
    await init().registerPushSubscription({ hash });
    await init().registerPushSubscription({ id: 'user-2' });

    expect(registrations().map((c) => c.body.user_hash)).toEqual([
      hash,
      undefined,
      undefined,
    ]);
    expect('user_hash' in registrations()[1].body).toBe(false);
    expect(registrations()[1].body.external_id).toMatch(/^anon:/);
  });

  test('a `hash` without an `id` is dropped with one console.warn per worker, which does not show it', async () => {
    const hash = await userHash(IDENTITY_SECRET, 'user-1');

    await init().registerPushSubscription({ id: 'user-1', hash });
    await init().registerPushSubscription();
    expect(warnings).toEqual([]);

    await init().registerPushSubscription({ hash });
    await init().registerPushSubscription({ hash, email: 'a@b.co' });
    await init().registerPushSubscription({ id: '  ', hash, name: 'A' });

    expect(warnings.length).toBe(1);
    expect(String(warnings[0][0])).toContain('`hash`');
    expect(JSON.stringify(warnings)).not.toContain(hash);
    expect(registrations().filter((c) => 'user_hash' in c.body).length).toBe(1);

    env.restartWorker();
    await init().registerPushSubscription({ hash, email: 'c@d.co' });
    expect(warnings.length).toBe(2);
  });

  test('201 (new) and 200 (already registered) both complete the registration; `expirationTime` is passed through', async () => {
    const statuses: number[] = [];
    const fake = (globalThis as any).fetch;
    (globalThis as any).fetch = async (...args: unknown[]) => {
      const response = await fake(...args);
      if (String(args[0]).endsWith('/v1/subscriptions')) {
        statuses.push(response.status);
      }
      return response;
    };

    await init().registerPushSubscription({ id: 'user-1' });
    env.storage['pt_registration'].registeredAt -= 25 * 60 * 60 * 1000;
    await init().registerPushSubscription({ id: 'user-1' });
    expect(statuses).toEqual([201, 200]);
    expect(
      Math.abs(Date.now() - env.storage['pt_registration'].registeredAt),
    ).toBeLessThan(5_000);

    const toJSON = env.subscription.toJSON;
    env.subscription.toJSON = () => ({ ...toJSON(), expirationTime: 1234 });
    await init().registerPushSubscription({ id: 'user-1' });
    expect(
      registrations().map((c) => c.body.subscription.expirationTime),
    ).toEqual([null, null, 1234]);
  });

  test('the hash is part of the fingerprint: a new one re-registers, the same one does not, and it never reaches chrome.storage.local', async () => {
    const first = await userHash(IDENTITY_SECRET, 'user-1');
    const rotated = await userHash('rotated-secret', 'user-1');
    const register = async (user: object) => {
      env.fetchCalls.length = 0;
      await init().registerPushSubscription(user);
      return registrations().map((c) => c.body.user_hash);
    };

    expect(await register({ id: 'user-1', hash: first })).toEqual([first]);
    const fingerprint = env.storage['pt_registration'].fingerprint;
    expect(await register({ id: 'user-1', hash: first })).toEqual([]);
    expect(env.storage['pt_registration'].fingerprint).toBe(fingerprint);

    env.identitySecret = 'rotated-secret';
    expect(await register({ id: 'user-1', hash: rotated })).toEqual([rotated]);
    expect(env.storage['pt_registration'].fingerprint).not.toBe(fingerprint);
    expect(await register({ id: 'user-1', hash: rotated })).toEqual([]);
    expect(await register({ id: 'user-1' })).toEqual([undefined]);

    await register({ id: 'user-1', hash: rotated });
    // chrome.storage.local (on disk, readable by content scripts) holds the
    // id and a one-way fingerprint, never the proof itself.
    expect(JSON.stringify(env.storage)).not.toContain(rotated);
    expect(JSON.stringify(env.storage)).not.toContain(first);
    expect(env.storage['pt_identity']).toEqual({ id: 'user-1', details: true });
    expect(Object.keys(env.storage).sort()).toEqual([
      'pt_anonymousId',
      'pt_identity',
      'pt_registration',
      'pt_vapidKey',
    ]);
    // The proof last given is in session storage; a superseded one is gone.
    expect(env.session['pt_identity']).toEqual({
      user: { id: 'user-1', hash: rotated },
    });
    expect(JSON.stringify(env.session)).not.toContain(first);
  });

  test('the hash is checked over the id as the SDK sends it: trimmed, a number as its decimal string, nothing else changed', async () => {
    // push-api's check vector.
    const vector =
      '71a48035b503170a70367c1c0ee323ea2477df3d0f43241ff3451f463b87551e';
    expect(await userHash('example-secret', 'user-123')).toBe(vector);

    await init().registerPushSubscription({
      id: ' \tuser-123\n',
      hash: vector,
    });
    await init().registerPushSubscription({
      id: 42,
      hash: await userHash(IDENTITY_SECRET, '42'),
    });
    // Case and inner whitespace are part of the id.
    await init().registerPushSubscription({
      id: 'User 123',
      hash: (await userHash(IDENTITY_SECRET, 'User 123')).toUpperCase(),
    });
    expect(registrations().map((c) => c.body.external_id)).toEqual([
      'user-123',
      '42',
      'User 123',
    ]);

    // A hash of the id before the SDK trimmed it, or in another case, is
    // refused.
    for (const hashed of [' user-9', 'USER-9']) {
      await expect(
        init().registerPushSubscription({
          id: ' user-9',
          hash: await userHash(IDENTITY_SECRET, hashed),
        }),
      ).rejects.toMatchObject({ status: 403, code: 'invalid_user_hash' });
    }
    await init().registerPushSubscription({
      id: ' user-9',
      hash: await userHash(IDENTITY_SECRET, 'user-9'),
    });
  });

  const refusedThenAccepted = async (
    code: string,
    refused: object,
    accepted: object,
  ) => {
    const error = await init()
      .registerPushSubscription(refused)
      .catch((e) => e);

    expect(error).toBeInstanceOf(PushToApiError);
    expect(error).toMatchObject({ status: 403, code });
    expect(registrations().length).toBe(1); // not retried
    expect(env.storage['pt_registration']).toBeUndefined();
    expect(env.unsubscribeCalls).toBe(0);
    expect(env.subscription.endpoint).toMatch(/sub-1$/);

    // Not cached: the same call asks again.
    await expect(
      init().registerPushSubscription(refused),
    ).rejects.toMatchObject({ code });
    expect(registrations().length).toBe(2);

    await init().registerPushSubscription(accepted);
    expect(registrations().length).toBe(3);
    expect(env.storage['pt_registration']).toBeDefined();
  };

  test('403 user_hash_required (verification on, id without hash): not retried, not cached, nothing unsubscribed', async () => {
    env.identityRequired = true;
    await refusedThenAccepted(
      'user_hash_required',
      { id: 'user-1' },
      { id: 'user-1', hash: await userHash(IDENTITY_SECRET, 'user-1') },
    );
  });

  test('403 invalid_user_hash (checked even with verification off): not retried, not cached, nothing unsubscribed', async () => {
    await refusedThenAccepted(
      'invalid_user_hash',
      { id: 'user-1', hash: await userHash(IDENTITY_SECRET, 'user-2') },
      { id: 'user-1', hash: await userHash(IDENTITY_SECRET, 'user-1') },
    );
  });

  test('a hash sent to a tenant that never issued a secret is 403 invalid_user_hash', async () => {
    env.identitySecret = undefined;
    await expect(
      init().registerPushSubscription({
        id: 'user-1',
        hash: await userHash(IDENTITY_SECRET, 'user-1'),
      }),
    ).rejects.toMatchObject({ status: 403, code: 'invalid_user_hash' });
    await init().registerPushSubscription({ id: 'user-1' });
  });

  test('with verification on, an anonymous subscriber registers without a hash', async () => {
    env.identityRequired = true;

    await init().registerPushSubscription();
    await init().registerPushSubscription({ email: 'a@b.co' });

    expect(registrations().length).toBe(2);
    expect(registrations().some((c) => 'user_hash' in c.body)).toBe(false);
    expect(env.storage['pt_registration']).toBeDefined();
  });

  test('503 identity_verification_unavailable is not transient: one request, not cached; other 503s are still retried', async () => {
    env.identityRequired = true;
    env.signingKeyConfigured = false;
    const user = {
      id: 'user-1',
      hash: await userHash(IDENTITY_SECRET, 'user-1'),
    };

    for (let attempt = 1; attempt <= 2; attempt++) {
      const error = await init()
        .registerPushSubscription(user)
        .catch((e) => e);
      expect(error).toBeInstanceOf(PushToApiError);
      expect(error).toMatchObject({
        status: 503,
        code: 'identity_verification_unavailable',
      });
      expect(registrations().length).toBe(attempt);
    }
    expect(env.storage['pt_registration']).toBeUndefined();
    expect(env.unsubscribeCalls).toBe(0);

    // An anonymous subscriber needs no check, so it still registers.
    await init().registerPushSubscription();
    expect(env.storage['pt_registration']).toBeDefined();

    env.signingKeyConfigured = true;
    env.fetchCalls.length = 0;
    let busy = 2;
    env.intercept = (call) =>
      call.path === '/v1/subscriptions' && busy-- > 0
        ? jsonResponse(503, { error: { code: 'busy', message: 'try again' } })
        : undefined;
    await init().registerPushSubscription(user);
    expect(registrations().length).toBe(3);
  });

  test('409 endpoint_conflict: the subscription is replaced once and the new one is registered', async () => {
    env.intercept = (call) =>
      call.path === '/v1/subscriptions' &&
      call.body.subscription.endpoint.endsWith('sub-1')
        ? conflict()
        : undefined;

    await init().registerPushSubscription({ id: 'user-1' });

    expect(env.unsubscribeCalls).toBe(1);
    expect(env.subscribeCalls.length).toBe(2);
    expect(env.subscription.endpoint).toMatch(/sub-2$/);
    expect(registrations().map((c) => c.body.subscription)).toEqual([
      {
        endpoint: 'https://fcm.googleapis.com/fcm/send/sub-1',
        expirationTime: null,
        keys: { p256dh: 'p256dh-1', auth: 'auth-1' },
      },
      {
        endpoint: 'https://fcm.googleapis.com/fcm/send/sub-2',
        expirationTime: null,
        keys: { p256dh: 'p256dh-2', auth: 'auth-2' },
      },
    ]);
    expect(calls('GET', '/v1/vapid-key').length).toBe(1);

    // What is remembered is the registration that went through.
    env.fetchCalls.length = 0;
    await init().registerPushSubscription({ id: 'user-1' });
    expect(env.fetchCalls.length).toBe(0);
    expect(env.unsubscribeCalls).toBe(1);
  });

  test('409 recovery is bounded: a second conflict is thrown, with one resubscribe and nothing cached', async () => {
    env.intercept = (call) =>
      call.path === '/v1/subscriptions' ? conflict() : undefined;

    const error = await init()
      .registerPushSubscription()
      .catch((e) => e);

    expect(error).toBeInstanceOf(PushToApiError);
    expect(error).toMatchObject({ status: 409, code: 'endpoint_conflict' });
    expect(registrations().length).toBe(2);
    expect(env.unsubscribeCalls).toBe(1);
    expect(env.subscribeCalls.length).toBe(2);
    expect(env.storage['pt_registration']).toBeUndefined();
  });

  test('409 recovery: another error on the retry is thrown as it is; another 409 code is not recovered', async () => {
    env.intercept = (call) =>
      call.path !== '/v1/subscriptions'
        ? undefined
        : call.body.subscription.endpoint.endsWith('sub-1')
          ? conflict()
          : jsonResponse(422, {
              error: { code: 'endpoint_limit_reached', message: 'at most 20' },
            });
    await expect(init().registerPushSubscription()).rejects.toMatchObject({
      status: 422,
      code: 'endpoint_limit_reached',
    });
    expect(registrations().length).toBe(2);
    expect(env.unsubscribeCalls).toBe(1);

    env.fetchCalls.length = 0;
    env.intercept = (call) =>
      call.path === '/v1/subscriptions'
        ? jsonResponse(409, { error: { code: 'conflict', message: 'other' } })
        : undefined;
    await expect(init().registerPushSubscription()).rejects.toMatchObject({
      status: 409,
      code: 'conflict',
    });
    expect(registrations().length).toBe(1);
    expect(env.unsubscribeCalls).toBe(1);
  });

  test('409 recovery: if the browser hands back the same subscription, the conflict is thrown without a second request', async () => {
    await init().registerPushSubscription();
    env.subscription.unsubscribe = async () => {
      env.unsubscribeCalls++;
      return false;
    };
    env.intercept = (call) =>
      call.path === '/v1/subscriptions' ? conflict() : undefined;
    env.fetchCalls.length = 0;

    await expect(
      init().registerPushSubscription({ id: 'user-1' }),
    ).rejects.toMatchObject({ code: 'endpoint_conflict' });

    expect(registrations().length).toBe(1);
    expect(env.unsubscribeCalls).toBe(1);
  });

  test('an unchanged re-register sends no POST; a restarted worker skips it too', async () => {
    const user = { id: 'user-1', email: 'a@b.co' };
    await init().registerPushSubscription(user);
    expect(calls('POST', /./).length).toBe(1);

    env.fetchCalls.length = 0;
    await init().registerPushSubscription(user);
    // Simulated SW restart: only chrome.storage.local carries over.
    resetSingletons();
    await init().registerPushSubscription({ ...user });

    expect(calls('POST', /./).length).toBe(0);
    expect(env.subscribeCalls.length).toBe(1); // the existing subscription is reused
    expect(env.unsubscribeCalls).toBe(0);
  });

  test('with `vapidPublicKey` an unchanged re-register makes no network call at all', async () => {
    const sdk = init({ vapidPublicKey: env.serverVapidKey });
    await sdk.registerPushSubscription({ id: 'user-1' });
    env.fetchCalls.length = 0;

    await sdk.registerPushSubscription({ id: 'user-1' });

    expect(env.fetchCalls.length).toBe(0);
  });

  test('a change in the user, the identity, the subscription, the base URL or the key re-sends the call', async () => {
    const reRegisters = async (sdk: PushNotifications, user?: object) => {
      env.fetchCalls.length = 0;
      await sdk.registerPushSubscription(user);
      return calls('POST', /./).map((c) => c.path);
    };
    const both = ['/v1/subscriptions'];

    await init().registerPushSubscription({ id: 'user-1', name: 'A B' });

    expect(await reRegisters(init(), { id: 'user-1', name: 'A B' })).toEqual(
      [],
    );
    expect(await reRegisters(init(), { id: 'user-1', name: 'A C' })).toEqual(
      both,
    );
    expect(
      await reRegisters(init(), { id: 'user-1', name: 'A C', language: 'fr' }),
    ).toEqual(both);
    expect(
      await reRegisters(init(), { id: 'user-2', name: 'A C', language: 'fr' }),
    ).toEqual(both);
    expect(await reRegisters(init())).toEqual(both); // back to anonymous
    expect(await reRegisters(init())).toEqual([]);
    expect(
      await reRegisters(init({ apiBaseUrl: 'https://elsewhere.test' })),
    ).toEqual(both);
    expect(
      await reRegisters(
        init({ apiBaseUrl: 'https://elsewhere.test', apiKey: 'another-key' }),
      ),
    ).toEqual(both);

    // A new browser subscription (new endpoint and keys).
    await env.subscription.unsubscribe();
    expect(
      await reRegisters(
        init({ apiBaseUrl: 'https://elsewhere.test', apiKey: 'another-key' }),
      ),
    ).toEqual(both);
    expect(registrations()[0].body.subscription.endpoint).toBe(
      'https://fcm.googleapis.com/fcm/send/sub-2',
    );
  });

  test('a failed registration is not cached: the next call sends it again', async () => {
    env.intercept = (call) =>
      call.path === '/v1/subscriptions'
        ? jsonResponse(422, {
            error: { code: 'endpoint_limit_reached', message: 'at most 20' },
          })
        : undefined;
    await expect(init().registerPushSubscription()).rejects.toMatchObject({
      code: 'endpoint_limit_reached',
    });
    expect(env.storage['pt_registration']).toBeUndefined();

    env.intercept = undefined;
    env.fetchCalls.length = 0;
    await init().registerPushSubscription();
    expect(calls('POST', /./).length).toBe(1);
  });

  test('throws outside a registered service worker', async () => {
    const sdk = init();
    (globalThis as any).self.registration = undefined;
    await expect(sdk.registerPushSubscription()).rejects.toThrow(
      /Service Worker registration/,
    );
  });
});

describe('VAPID key', () => {
  test('from the route when no option is given', async () => {
    await init().registerPushSubscription();

    expect(calls('GET', '/v1/vapid-key').length).toBe(1);
    const key = new Uint8Array(env.subscribeCalls[0].applicationServerKey);
    expect(key.length).toBe(65);
    expect(key[0]).toBe(4);
    expect(key[1]).toBe(1);
    expect(env.subscribeCalls[0].userVisibleOnly).toBe(true);
  });

  test('from the option: the route is not called', async () => {
    await init({ vapidPublicKey: vapidKey(9) }).registerPushSubscription();

    expect(calls('GET', '/v1/vapid-key').length).toBe(0);
    expect(new Uint8Array(env.subscribeCalls[0].applicationServerKey)[1]).toBe(
      9,
    );
  });

  test('an existing subscription made for another key is unsubscribed and replaced', async () => {
    await init({ vapidPublicKey: vapidKey(1) }).registerPushSubscription();
    expect(env.subscription.endpoint).toMatch(/sub-1$/);

    env.fetchCalls.length = 0;
    await init({ vapidPublicKey: vapidKey(2) }).registerPushSubscription();

    expect(env.unsubscribeCalls).toBe(1);
    expect(env.subscription.endpoint).toMatch(/sub-2$/);
    expect(
      new Uint8Array(env.subscription.options.applicationServerKey)[1],
    ).toBe(2);
    expect(registrations()[0].body.subscription.endpoint).toMatch(/sub-2$/);
  });

  test('a subscription that does not expose its key is reused if subscribe() accepts it, replaced if not', async () => {
    await init({ vapidPublicKey: vapidKey(1) }).registerPushSubscription();
    const realKey = env.subscription.options.applicationServerKey;
    const hideKey = () => {
      // The mock's subscribe() still compares against the real key.
      const hidden = env.subscription;
      const subscribe = (globalThis as any).self.registration.pushManager
        .subscribe;
      (globalThis as any).self.registration.pushManager.subscribe = async (
        options: any,
      ) => {
        hidden.options = { applicationServerKey: realKey };
        try {
          return await subscribe(options);
        } finally {
          if (env.subscription === hidden)
            hidden.options = { applicationServerKey: null };
        }
      };
      hidden.options = { applicationServerKey: null };
    };

    hideKey();
    await init({ vapidPublicKey: vapidKey(1) }).registerPushSubscription();
    expect(env.unsubscribeCalls).toBe(0);
    expect(env.subscription.endpoint).toMatch(/sub-1$/);

    await init({ vapidPublicKey: vapidKey(3) }).registerPushSubscription();
    expect(env.unsubscribeCalls).toBe(1);
    expect(env.subscription.endpoint).toMatch(/sub-2$/);
  });

  test('a malformed key or route answer is a clear error', async () => {
    await expect(
      init({ vapidPublicKey: '%%%' }).registerPushSubscription(),
    ).rejects.toThrow(/VAPID/);

    env.intercept = (call) =>
      call.path === '/v1/vapid-key' ? jsonResponse(200, {}) : undefined;
    await expect(init().registerPushSubscription()).rejects.toMatchObject({
      code: 'invalid_response',
    });
  });
});

describe('fetch wrapper', () => {
  const api = () => new ApiClient('k', `${API_BASE_URL}/v1`);
  const body = (email?: string) => ({
    external_id: 'u',
    ...(email ? { email } : {}),
    subscription: {
      endpoint: 'https://fcm.googleapis.com/fcm/send/x',
      keys: { p256dh: 'p', auth: 'a' },
    },
    metadata: { channel: 'extension' },
  });

  test('the push-api error envelope becomes a PushToApiError with status, code, message and details', async () => {
    env.intercept = () =>
      jsonResponse(422, {
        error: {
          code: 'validation_error',
          message: 'email must be an email address',
          details: { field: 'email' },
        },
      });

    const error = await api()
      .registerSubscription(body('nope'))
      .catch((e) => e);

    expect(error).toBeInstanceOf(PushToApiError);
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('PushToApiError');
    expect(error.status).toBe(422);
    expect(error.code).toBe('validation_error');
    expect(error.message).toBe('email must be an email address');
    expect(error.details).toEqual({ field: 'email' });
    expect(env.fetchCalls.length).toBe(1); // a 422 is not retried
  });

  test('an envelope without details, and the auth errors, parse the same way', async () => {
    env.intercept = () =>
      jsonResponse(401, {
        error: { code: 'unauthorized', message: 'missing or invalid API key' },
      });
    const error = await api()
      .getVapidPublicKey()
      .catch((e) => e);
    expect(error).toMatchObject({
      status: 401,
      code: 'unauthorized',
      message: 'missing or invalid API key',
    });
    expect(error.details).toBeUndefined();
    expect(env.fetchCalls.length).toBe(1);
  });

  test('an error without the envelope is `http_error` with the status', async () => {
    env.intercept = () =>
      new Response('<html>bad gateway</html>', { status: 502 });
    const error = await api()
      .getVapidPublicKey()
      .catch((e) => e);
    expect(error).toBeInstanceOf(PushToApiError);
    expect(error).toMatchObject({ status: 502, code: 'http_error' });
    expect(env.fetchCalls.length).toBe(1); // only 503 is retried

    env.intercept = () =>
      jsonResponse(500, { error: 'a string, not an object' });
    expect(
      await api()
        .getVapidPublicKey()
        .catch((e) => e),
    ).toMatchObject({ status: 500, code: 'http_error' });
  });

  test('503 is retried, then succeeds', async () => {
    let attempts = 0;
    env.intercept = () =>
      ++attempts <= 2
        ? jsonResponse(503, {
            error: {
              code: 'auth_unavailable',
              message: 'could not verify the API key, try again',
            },
          })
        : undefined;

    await api().registerSubscription(body());
    expect(env.fetchCalls.length).toBe(3);
    // The retried POST carries the same body.
    expect(env.fetchCalls.map((c) => c.body)).toEqual([body(), body(), body()]);
  });

  test('a network error is retried, then succeeds', async () => {
    let attempts = 0;
    env.intercept = () => {
      if (++attempts === 1) throw new TypeError('Failed to fetch');
      return undefined;
    };
    expect(await api().getVapidPublicKey()).toBe(env.serverVapidKey);
    expect(env.fetchCalls.length).toBe(2);
  });

  test('retries are bounded: 1 attempt + 2 retries, then the last error', async () => {
    env.intercept = () =>
      jsonResponse(503, { error: { code: 'busy', message: 'try again' } });
    expect(
      await api()
        .getVapidPublicKey()
        .catch((e) => e),
    ).toMatchObject({ status: 503, code: 'busy' });
    expect(env.fetchCalls.length).toBe(3);

    env.fetchCalls.length = 0;
    env.intercept = () => {
      throw new TypeError('Failed to fetch');
    };
    const error = await api()
      .getVapidPublicKey()
      .catch((e) => e);
    expect(error).toBeInstanceOf(PushToApiError);
    expect(error).toMatchObject({ status: 0, code: 'network_error' });
    expect(error.message).toContain('Failed to fetch');
    expect(env.fetchCalls.length).toBe(3);
  });

  test('the backoff doubles', async () => {
    ApiClient.retryBaseDelayMs = 30;
    const at: number[] = [];
    env.intercept = () => {
      at.push(performance.now());
      return jsonResponse(503, {
        error: { code: 'busy', message: 'try again' },
      });
    };
    await api()
      .getVapidPublicKey()
      .catch(() => undefined);
    expect(at[1] - at[0]).toBeGreaterThanOrEqual(25);
    expect(at[2] - at[1]).toBeGreaterThanOrEqual(55);
  });

  test('feedback is sent with keepalive; the other calls are not', async () => {
    await api().sendFeedback({ notification_id: 5, event_type: 'delivered' });
    await api().getVapidPublicKey();
    expect(env.fetchCalls.map((c) => c.keepalive)).toEqual([true, false]);
  });
});

describe('payload handling', () => {
  test('push-api shape: shown under String(notification_id) with the display contract applied', async () => {
    init();
    const waited = await env.push({
      title: 'Goal!',
      body: 'Arsenal 1-0',
      notification_id: 77,
      data: {
        url: 'https://example.com/match/1',
        icon: 'https://cdn.example.com/i.png',
        context_message: 'Premier League',
        badge: { text: '3', color: '#ff0000' },
        tag: 'match-1',
        auto_dismiss: { behavior: 'timed', dismiss_time_ms: 60_000 },
        image_url: 'https://cdn.example.com/hero.png', // not part of the contract: ignored
      },
    });

    expect(waited).toBe(1); // the work was handed to event.waitUntil
    expect(env.createCalls).toEqual([
      {
        id: '77',
        options: {
          title: 'Goal!',
          message: 'Arsenal 1-0',
          priority: 1,
          type: 'basic',
          isClickable: true,
          contextMessage: 'Premier League',
          iconUrl: 'https://cdn.example.com/i.png',
        },
      },
    ]);
    expect(env.storage['pt_notifications']['77']).toEqual({
      v: 2,
      id: '77',
      notificationId: 77,
      title: 'Goal!',
      message: 'Arsenal 1-0',
      icon: 'https://cdn.example.com/i.png',
      contextMessage: 'Premier League',
      url: 'https://example.com/match/1',
      badge: { text: '3', color: '#ff0000' },
      tag: 'match-1',
      autoDismissMs: 60_000,
    });
    expect(env.alarms.get('pt-dismiss:77')?.delayInMinutes).toBe(1);
    expect(env.badgeTextCalls).toEqual(['3']);
    expect(env.badgeColorCalls).toEqual(['#ff0000']);
  });

  test('`body: null`, a missing body and a missing `data` show an empty message and nothing else', async () => {
    init();
    await env.push({
      title: 'Only a title',
      body: null,
      data: {},
      notification_id: 1,
    });
    await env.push({ title: 'No body', notification_id: 2 });

    expect(env.createCalls.map((c) => c.options.message)).toEqual(['', '']);
    expect(env.createCalls[1].options.iconUrl).toBe(FALLBACK_ICON);
    expect(env.badgeTextCalls).toEqual([]);
    expect(env.alarms.size).toBe(0);
    expect(env.feedback().map((c) => c.body.notification_id)).toEqual([1, 2]);
  });

  test('members of `data` with the wrong type are ignored, not fatal', async () => {
    init();
    await env.push({
      title: 't',
      body: 'b',
      notification_id: 3,
      data: {
        url: 42,
        icon: 'http://insecure.example.com/i.png', // not https
        context_message: { nested: true },
        badge: 'three',
        tag: '',
        auto_dismiss: { behavior: 'timed', dismiss_time_ms: '5000' },
      },
    });

    expect(env.storage['pt_notifications']['3']).toEqual({
      v: 2,
      id: '3',
      notificationId: 3,
      title: 't',
      message: 'b',
    });
    expect(env.createCalls[0].options.iconUrl).toBe(FALLBACK_ICON);
    expect(env.alarms.size).toBe(0);

    expect(
      normalizePayload({
        title: 't',
        notification_id: 4,
        data: { auto_dismiss: { behavior: 'device_default' } },
      }),
    ).toEqual({ v: 2, id: '4', notificationId: 4, title: 't', message: '' });
    expect(
      normalizePayload({
        title: 't',
        notification_id: 5,
        data: { badge: { text: '1' } },
      })?.badge,
    ).toEqual({
      text: '1',
    });
    expect(
      normalizePayload({ title: 't', notification_id: 6, data: [] })?.id,
    ).toBe('6');
  });

  test('legacy shape is still displayed, with its link, badge and auto-dismiss, and is never tracked', async () => {
    init();
    await env.push({
      title: 'Legacy',
      options: {
        body: 'old backend',
        icon: 'https://old.example.com/icon.png',
        contextMessage: 'ctx',
        data: {
          correlationId: 'corr-1',
          link: 'https://example.com/legacy',
          badge: { text: '1', color: '#000' },
          tag: 'old',
          autoDismissOptions: { behavior: 'device_default' },
        },
      },
    });

    expect(env.createCalls).toEqual([
      {
        id: 'corr-1',
        options: {
          title: 'Legacy',
          message: 'old backend',
          priority: 1,
          type: 'basic',
          isClickable: true,
          contextMessage: 'ctx',
          requireInteraction: true,
          iconUrl: 'https://old.example.com/icon.png',
        },
      },
    ]);
    expect(env.badgeTextCalls).toEqual(['1']);

    env.click('corr-1');
    await sleep(20);
    expect(env.tabsCreateCalls).toEqual([
      { url: 'https://example.com/legacy' },
    ]);

    await env.push({
      title: 'Legacy 2',
      options: {
        body: 'b',
        icon: 'i',
        data: {
          correlationId: 'corr-2',
          autoDismissOptions: { behavior: 'timed', dismissTimeMS: 90_000 },
        },
      },
    });
    expect(env.alarms.get('pt-dismiss:corr-2')?.delayInMinutes).toBe(1.5);
    env.userClose('corr-2');
    await sleep(20);

    expect(env.fetchCalls.length).toBe(0); // no delivered, clicked, opened or dismissed
    expect(env.storage['pt_notifications']).toEqual({});
  });

  test('a legacy id that names an Object.prototype member is stored and found again on click', async () => {
    init();
    const legacy = (correlationId: string) => ({
      title: 'Legacy',
      options: {
        body: 'b',
        data: { correlationId, link: `https://example.com/${correlationId}` },
      },
    });
    const stored = () => env.storage['pt_notifications'];

    for (const id of ['__proto__', 'toString']) {
      // Nothing is stored yet: an inherited member is not an entry.
      env.click(id);
      await sleep(20);
      expect(env.tabsCreateCalls).toEqual([]);

      await env.push(legacy(id));
      expect(Object.keys(stored())).toEqual([id]);
      expect(Object.getPrototypeOf(stored())).toBe(Object.prototype);

      env.click(id);
      await sleep(20);
      expect(env.tabsCreateCalls.splice(0)).toEqual([
        { url: `https://example.com/${id}` },
      ]);
      expect(Object.keys(stored())).toEqual([]);
    }
    expect(unhandled).toEqual([]);
  });

  test('a payload that is neither shape does not throw out of the push handler: logged, nothing shown', async () => {
    init();
    const garbage: unknown[] = [
      'a string',
      42,
      true,
      [],
      [{ title: 't', notification_id: 1 }],
      {},
      { title: 'no id' },
      { notification_id: 8 },
      { title: 7, notification_id: 8 },
      { title: 't', notification_id: '8' },
      { title: 't', notification_id: 0 },
      { title: 't', notification_id: -1 },
      { title: 't', notification_id: 1.5 },
      { title: 't', notification_id: null },
      { title: 't', options: null },
      { title: 't', options: {} },
      { title: 't', options: { data: 'x' } },
      { title: 't', options: { data: {} } },
      { title: 't', options: { data: { correlationId: '' } } },
    ];

    for (const payload of garbage) {
      expect(normalizePayload(payload)).toBeUndefined();
      expect(await env.push(payload)).toBe(0);
    }
    // A body that is not JSON at all, and a push with no data.
    await env.push({}, () => {
      throw new SyntaxError('Unexpected token');
    });
    await env.push(null);
    expect(normalizePayload(null)).toBeUndefined();
    expect(normalizePayload(undefined)).toBeUndefined();

    expect(env.createCalls.length).toBe(0);
    expect(env.fetchCalls.length).toBe(0);
    expect(env.storage['pt_notifications']).toBeUndefined();
    expect(warnings.length).toBe(garbage.length + 1); // every one but the data-less push
    expect(unhandled).toEqual([]);
  });

  test('a notification that cannot be created at all is not reported as delivered and leaves no state', async () => {
    init();
    env.createError = () => 'Notifications permission missing';

    await env.push({
      title: 't',
      body: 'b',
      notification_id: 9,
      data: { badge: { text: '1' } },
    });

    expect(env.active.size).toBe(0);
    expect(env.feedback().length).toBe(0);
    expect(env.storage['pt_notifications']).toEqual({});
    expect(env.badgeTextCalls).toEqual([]);
    expect(unhandled).toEqual([]);
  });
});

describe('icon fallback chain', () => {
  const pushWithIcon = (notificationId: number, icon?: string) =>
    env.push({
      title: 't',
      body: 'b',
      notification_id: notificationId,
      data: icon ? { icon } : {},
    });
  const shownIcon = (id: string) => env.active.get(id)?.iconUrl;

  test('constructor default → data.icon → largest manifest icon → embedded PNG', async () => {
    env.manifest = {
      icons: {
        '16': 'icons/16.png',
        '128': '/icons/128.png',
        '48': 'icons/48.png',
      },
    };

    init({ defaultNotificationIcon: 'https://example.com/default.png' });
    await pushWithIcon(1, 'https://cdn.example.com/payload.png');
    expect(shownIcon('1')).toBe('https://example.com/default.png');

    init(); // re-init without a default
    await pushWithIcon(2, 'https://cdn.example.com/payload.png');
    expect(shownIcon('2')).toBe('https://cdn.example.com/payload.png');

    await pushWithIcon(3);
    expect(shownIcon('3')).toBe('chrome-extension://ext-test-id/icons/128.png');

    env.manifest = {};
    await pushWithIcon(4);
    expect(shownIcon('4')).toBe(FALLBACK_ICON);

    env.manifest = { icons: {} };
    await pushWithIcon(5);
    expect(shownIcon('5')).toBe(FALLBACK_ICON);

    (globalThis as any).chrome.runtime.getManifest = () => {
      throw new Error('no manifest');
    };
    await pushWithIcon(6);
    expect(shownIcon('6')).toBe(FALLBACK_ICON);
  });

  test('the embedded fallback is a PNG data URL', () => {
    expect(FALLBACK_ICON.startsWith('data:image/png;base64,')).toBe(true);
    const bytes = atob(FALLBACK_ICON.split(',')[1]);
    expect(bytes.slice(1, 4)).toBe('PNG');
    expect(bytes.slice(-8, -4)).toBe('IEND');
  });

  test('an icon Chrome cannot load falls through to the next candidate, and the notification is still delivered', async () => {
    env.manifest = { icons: { '128': 'icons/128.png' } };
    env.createError = (options) =>
      options.iconUrl.startsWith('https://')
        ? 'Unable to download all specified images.'
        : undefined;
    init({ defaultNotificationIcon: 'https://example.com/default.png' });

    await pushWithIcon(7, 'https://cdn.example.com/payload.png');

    expect(env.createCalls.map((c) => c.options.iconUrl)).toEqual([
      'https://example.com/default.png',
      'https://cdn.example.com/payload.png',
      'chrome-extension://ext-test-id/icons/128.png',
    ]);
    expect(shownIcon('7')).toBe('chrome-extension://ext-test-id/icons/128.png');
    expect(env.feedbackTypes(7)).toEqual(['delivered']);
  });
});

describe('click target — only http(s) URLs are opened', () => {
  test('safeHttpUrl', () => {
    expect(safeHttpUrl('https://example.com/a?b=c#d')).toBe(
      'https://example.com/a?b=c#d',
    );
    expect(safeHttpUrl('http://example.com')).toBe('http://example.com/');
    expect(safeHttpUrl('HTTPS://EXAMPLE.com/x')).toBe('https://example.com/x');
    for (const bad of [
      'javascript:alert(1)',
      ' javascript:alert(1)',
      'JaVaScRiPt:alert(1)',
      'chrome://settings',
      'chrome-extension://abc/page.html',
      'file:///etc/passwd',
      'data:text/html,<script>alert(1)</script>',
      'blob:https://example.com/uuid',
      '/relative/path',
      'relative',
      '//example.com/protocol-relative',
      'example.com',
      '',
      '   ',
      undefined,
      null,
      42,
      {},
    ]) {
      expect(safeHttpUrl(bad)).toBeUndefined();
    }
  });

  test.each([
    ['javascript:', 'javascript:alert(document.cookie)'],
    ['chrome:', 'chrome://settings'],
    ['relative', '/deals/1'],
    ['missing', undefined],
  ])(
    '%s url: no tab is opened, `clicked` is still recorded, `opened` is not',
    async (_name, url) => {
      init();
      await env.push({
        title: 't',
        body: 'b',
        notification_id: 50,
        data: url === undefined ? {} : { url },
      });

      env.click('50');
      await sleep(20);

      expect(env.tabsCreateCalls).toEqual([]);
      expect(env.feedbackTypes(50)).toEqual(['delivered', 'clicked']);
      expect(env.active.has('50')).toBe(false); // the click still clears it
    },
  );

  test('http and https urls are opened', async () => {
    init();
    await env.push({
      title: 't',
      body: 'b',
      notification_id: 51,
      data: { url: 'http://example.com/a' },
    });
    await env.push({
      title: 't',
      body: 'b',
      notification_id: 52,
      data: { url: 'https://example.com/b' },
    });
    env.click('51');
    env.click('52');
    await sleep(20);
    expect(env.tabsCreateCalls.map((c) => c.url).sort()).toEqual([
      'http://example.com/a',
      'https://example.com/b',
    ]);
  });
});

describe('feedback — POST /v1/feedback', () => {
  test('shown → delivered; click → clicked; tab created → opened; with a numeric id and no client timestamp', async () => {
    init();
    await env.push({
      title: 't',
      body: 'b',
      notification_id: 60,
      data: { url: 'https://example.com/x' },
    });
    expect(env.feedbackTypes(60)).toEqual(['delivered']);

    env.click('60');
    await sleep(20);

    expect(env.feedbackTypes(60)).toEqual(['delivered', 'clicked', 'opened']);
    for (const call of env.feedback()) {
      expect(call.method).toBe('POST');
      expect(call.url).toBe(`${API_BASE_URL}/v1/feedback`);
      expect(call.keepalive).toBe(true);
      expect(Object.keys(call.body).sort()).toEqual([
        'event_type',
        'notification_id',
      ]);
      expect(call.body.notification_id).toBe(60);
      expect(typeof call.body.notification_id).toBe('number');
    }
  });

  test('`opened` is sent only after chrome.tabs.create resolves, and not at all if it rejects', async () => {
    init();
    await env.push({
      title: 't',
      body: 'b',
      notification_id: 61,
      data: { url: 'https://example.com/x' },
    });

    let resolveTab!: () => void;
    (globalThis as any).chrome.tabs.create = (opts: { url: string }) =>
      new Promise<void>((resolve) => {
        resolveTab = () => {
          env.tabsCreateCalls.push(opts);
          resolve();
        };
      });
    env.click('61');
    await sleep(20);
    expect(env.feedbackTypes(61)).toEqual(['delivered', 'clicked']);

    resolveTab();
    await sleep(20);
    expect(env.feedbackTypes(61)).toEqual(['delivered', 'clicked', 'opened']);

    await env.push({
      title: 't',
      body: 'b',
      notification_id: 62,
      data: { url: 'https://example.com/y' },
    });
    (globalThis as any).chrome.tabs.create = async () => {
      throw new Error('No current window');
    };
    env.click('62');
    await sleep(20);
    expect(env.feedbackTypes(62)).toEqual(['delivered', 'clicked']);
    expect(unhandled).toEqual([]);
  });

  test('user close → dismissed; click, timed auto-dismiss and tag replacement → never dismissed', async () => {
    init();
    const push = (notificationId: number, data: object = {}) =>
      env.push({
        title: 't',
        body: 'b',
        notification_id: notificationId,
        data,
      });

    await push(70);
    env.userClose('70');

    await push(71);
    env.click('71');

    await push(72, {
      auto_dismiss: { behavior: 'timed', dismiss_time_ms: 120_000 },
    });
    env.fireAlarm('pt-dismiss:72');

    await push(73, { tag: 'same' });
    await push(74, { tag: 'same' });
    await sleep(30);

    expect(env.feedbackTypes(70)).toEqual(['delivered', 'dismissed']);
    expect(env.feedbackTypes(71)).toEqual(['delivered', 'clicked']);
    expect(env.feedbackTypes(72)).toEqual(['delivered']);
    expect(env.feedbackTypes(73)).toEqual(['delivered']);
    expect(env.feedbackTypes(74)).toEqual(['delivered']);
    expect(env.active.has('73')).toBe(false);
    expect([...env.active.keys()]).toEqual(['74']);

    // Once the replacement is closed by the user, that one is a dismissal.
    env.userClose('74');
    await sleep(20);
    expect(env.feedbackTypes(74)).toEqual(['delivered', 'dismissed']);
    expect(env.storage['pt_notifications']).toEqual({});
  });

  test('a close for an id the SDK has no state for reports nothing', async () => {
    init();
    env.userClose('999');
    env.click('998');
    await sleep(20);
    expect(env.fetchCalls.length).toBe(0);
    expect(unhandled).toEqual([]);
  });

  test('the `delivered` post is awaited inside event.waitUntil', async () => {
    init();
    let finished = false;
    env.intercept = async (call) => {
      if (call.path !== '/v1/feedback') return undefined;
      await sleep(30);
      finished = true;
      return jsonResponse(202, { accepted: true });
    };

    await env.push({ title: 't', body: 'b', notification_id: 80 });

    expect(finished).toBe(true); // push() resolves when the waitUntil promises do
  });

  test('a failing feedback call never rejects or throws: it is logged', async () => {
    init();
    ApiClient.maxRetries = 0;

    for (const failure of [
      () =>
        jsonResponse(404, {
          error: {
            code: 'notification_not_found',
            message: 'notification not found',
          },
        }),
      () =>
        jsonResponse(401, {
          error: {
            code: 'unauthorized',
            message: 'missing or invalid API key',
          },
        }),
      () =>
        jsonResponse(503, { error: { code: 'busy', message: 'try again' } }),
      () => new Response('not json', { status: 500 }),
      () => {
        throw new TypeError('Failed to fetch');
      },
    ]) {
      env.intercept = failure;
      warnings.length = 0;
      const id = 90 + warnings.length + env.createCalls.length;

      // delivered (inside waitUntil), then clicked + opened, then dismissed.
      expect(
        await env.push({
          title: 't',
          body: 'b',
          notification_id: id,
          data: { url: 'https://example.com' },
        }),
      ).toBe(1);
      expect(env.active.has(String(id))).toBe(true); // still shown
      env.click(String(id));
      await sleep(20);
      await env.push({ title: 't', body: 'b', notification_id: id + 100 });
      env.userClose(String(id + 100));
      await sleep(20);

      // The click still worked, in this iteration.
      expect(env.tabsCreateCalls.splice(0)).toEqual([
        { url: 'https://example.com/' },
      ]);
      expect(warnings.length).toBe(5); // delivered, clicked, opened, delivered, dismissed
      expect(String(warnings[0][0])).toContain('delivered');
    }
    expect(unhandled).toEqual([]);
    expect(env.storage['pt_notifications']).toEqual({});
  });

  test('feedback is retried on 503 like every other call', async () => {
    init();
    let attempts = 0;
    env.intercept = (call) =>
      call.path === '/v1/feedback' && ++attempts === 1
        ? jsonResponse(503, { error: { code: 'busy', message: 'try again' } })
        : undefined;

    await env.push({ title: 't', body: 'b', notification_id: 95 });

    expect(env.feedbackTypes(95)).toEqual(['delivered', 'delivered']);
    expect(warnings).toEqual([]);
  });
});

describe('re-initialisation', () => {
  test('constructing again, with the same or different options, does not duplicate any listener', () => {
    init();
    init();
    init({ defaultNotificationIcon: 'https://example.com/a.png' });
    init({
      defaultNotificationIcon: 'https://example.com/b.png',
      apiKey: 'second-key',
    });
    init();

    expect(env.pushListeners.length).toBe(1);
    expect(env.actionOnClicked.listeners.length).toBe(1);
    expect(env.alarmsOnAlarm.listeners.length).toBe(1);
    expect(env.notificationsOnClicked.listeners.length).toBe(1);
    expect(env.notificationsOnClosed.listeners.length).toBe(2); // PushNotificationEvents + Dismiss
  });

  test('after a re-init one push shows one notification and sends one `delivered`, with the latest options', async () => {
    init({ defaultNotificationIcon: 'https://example.com/a.png' });
    init({
      defaultNotificationIcon: 'https://example.com/b.png',
      apiKey: 'second-key',
      apiBaseUrl: 'https://second.test',
    });

    await env.push({
      title: 't',
      body: 'b',
      notification_id: 100,
      data: { url: 'https://example.com' },
    });
    env.click('100');
    await sleep(20);

    expect(env.createCalls.length).toBe(1);
    expect(env.createCalls[0].options.iconUrl).toBe(
      'https://example.com/b.png',
    );
    expect(env.feedbackTypes(100)).toEqual(['delivered', 'clicked', 'opened']);
    expect(env.tabsCreateCalls.length).toBe(1);
    for (const call of env.feedback()) {
      expect(call.url).toBe('https://second.test/v1/feedback');
      expect(call.headers.Authorization).toBe('Bearer second-key');
    }
  });

  test('the toolbar action click clears the badge once', async () => {
    init();
    init();
    await env.push({
      title: 't',
      body: 'b',
      notification_id: 101,
      data: { badge: { text: '1' } },
    });
    env.actionOnClicked.listeners.forEach((l) => l());
    await sleep(10);
    expect(env.badgeTextCalls).toEqual(['1', '']);
  });
});
