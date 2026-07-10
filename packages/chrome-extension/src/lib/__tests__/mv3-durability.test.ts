/**
 * Mocked-chrome MV3 durability checks — Phase 3 Wave 1
 * (core/docs/Specs/Phase 3 - PRD.md §Wave 1, items 3.3a/3.3b + AC1).
 *
 * Run: PUSHTO_CORE_URL=https://core.test bun test src/lib/__tests__/mv3-durability.test.ts
 * (run from packages/chrome-extension)
 *
 * Excluded from the package's `tsc --noEmit` gate via tsconfig.json's
 * `**\/*.test.ts` exclude (mirroring the existing `**\/*.spec.ts` exclusion) —
 * this project has no `bun` types wired in yet, only `node`/`chrome`.
 *
 * Mocks chrome.storage.local / chrome.alarms / chrome.notifications /
 * chrome.action / chrome.tabs / self and imports the real source modules
 * directly. Each test resets both the mock chrome environment AND the
 * modules' private static singletons, so every `test()` starts from a state
 * equivalent to a genuinely fresh MV3 service-worker instantiation.
 */

import { beforeEach, describe, expect, test } from 'bun:test';
import { NotificationsState } from '../notifications-state';
import { Dismiss } from '../dismiss';
import { PushNotificationEvents } from '../push-notification-events';
import { ReceiveNotification } from '../receive-notification';
import { PushNotifications } from '../pushto-chrome-extension';

type Listener = (...args: any[]) => any;
function makeEvent() {
  const listeners: Listener[] = [];
  return { addListener: (fn: Listener) => listeners.push(fn), listeners };
}

let storageBackend: Record<string, any>;
let alarmsBackend: Map<string, { delayInMinutes: number }>;
let activeNotifications: Set<string>;
let fetchCalls: { url: string; body: any }[];
let badgeTextCalls: string[];
let tabsCreateCalls: { url: string }[];
let notificationsOnClicked: ReturnType<typeof makeEvent>;
let notificationsOnClosed: ReturnType<typeof makeEvent>;
let alarmsOnAlarm: ReturnType<typeof makeEvent>;
let actionOnClicked: ReturnType<typeof makeEvent>;
let pushListeners: Listener[];

function installMocks() {
  storageBackend = {};
  alarmsBackend = new Map();
  activeNotifications = new Set();
  fetchCalls = [];
  badgeTextCalls = [];
  tabsCreateCalls = [];
  notificationsOnClicked = makeEvent();
  notificationsOnClosed = makeEvent();
  alarmsOnAlarm = makeEvent();
  actionOnClicked = makeEvent();
  pushListeners = [];

  (globalThis as any).fetch = async (_url: string, init: any) => {
    fetchCalls.push({ url: _url, body: init?.body ? JSON.parse(init.body) : undefined });
    return { ok: true, status: 200, json: async () => ({}), text: async () => '' } as unknown as Response;
  };

  const chromeMock: any = {
    storage: {
      local: {
        get: async (key: string) => ({ [key]: storageBackend[key] }),
        set: async (obj: Record<string, any>) => {
          Object.assign(storageBackend, obj);
        },
      },
    },
    alarms: {
      create: async (name: string, info: { delayInMinutes: number }) => {
        alarmsBackend.set(name, info);
      },
      clear: async (name: string) => {
        alarmsBackend.delete(name);
      },
      onAlarm: alarmsOnAlarm,
    },
    notifications: {
      create: (id: string) => {
        activeNotifications.add(id);
      },
      clear: (id: string) => {
        activeNotifications.delete(id);
        // Real chrome.notifications.clear() asynchronously fires onClosed —
        // model that cascade so read-before-clear ordering bugs are actually
        // exercised (see "Click path ordering" below).
        queueMicrotask(() => notificationsOnClosed.listeners.forEach((l) => l(id, false)));
      },
      getAll: (cb: (obj: Record<string, unknown>) => void) => {
        const obj: Record<string, unknown> = {};
        for (const id of activeNotifications) obj[id] = {};
        cb(obj);
      },
      onClicked: notificationsOnClicked,
      onClosed: notificationsOnClosed,
    },
    action: {
      setBadgeText: (opts: { text: string }) => {
        badgeTextCalls.push(opts.text);
      },
      setBadgeBackgroundColor: () => {},
      onClicked: actionOnClicked,
    },
    tabs: {
      create: (opts: { url: string }) => {
        tabsCreateCalls.push(opts);
      },
    },
    runtime: {
      getURL: (p: string) => `chrome-extension://test/${p}`,
    },
  };
  (globalThis as any).chrome = chromeMock;
  (globalThis as any).self = {
    addEventListener: (type: string, fn: Listener) => {
      if (type === 'push') pushListeners.push(fn);
    },
    removeEventListener: () => {},
    registration: {},
  };
  (globalThis as any).ServiceWorkerGlobalScope = class {};
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

beforeEach(() => {
  installMocks();
  // Reset every module's private static singleton so each test starts from
  // a state equivalent to a genuinely fresh MV3 service-worker instantiation
  // (a real restart gets a brand-new JS realm; these classes cache
  // themselves in a `static` field that would otherwise leak across tests
  // sharing this process/module cache).
  (NotificationsState as any).notificationsState = undefined;
  (Dismiss as any).dismiss = undefined;
  (PushNotificationEvents as any).pushNotificationEvents = undefined;
  (ReceiveNotification as any).instance = undefined;
});

describe('NotificationsState (3.3a) — chrome.storage.local persistence', () => {
  test('write, then a fresh singleton instance backed by the same storage reads it back (simulated SW restart)', async () => {
    const notif = {
      title: 't',
      options: {
        body: 'b',
        icon: 'i',
        data: { correlationId: 'n1', autoDismissOptions: { behavior: 'timed', dismissTimeMS: 1000 } },
      },
    } as any;

    await NotificationsState.instance.addNotification('n1', notif);
    expect(storageBackend['pt_notifications']?.n1?.options?.data?.correlationId).toBe('n1');

    // Simulate the SW restart mid-test: a fresh JS realm resets the static
    // singleton to undefined. storageBackend is untouched -- it models
    // chrome.storage.local, which lives in the browser, not the worker.
    (NotificationsState as any).notificationsState = undefined;
    const freshInstance = NotificationsState.instance;

    const got = await freshInstance.getNotification('n1');
    expect(got?.options?.data?.correlationId).toBe('n1');
  });

  test('removeNotificationsByTag removes all matching entries and tracks each as auto-dismissed', async () => {
    const base = {
      title: 't',
      options: { body: 'b', icon: 'i', data: { autoDismissOptions: { behavior: 'device_default' }, tag: 'grp' } },
    } as any;
    await NotificationsState.instance.addNotification('tag-a', {
      ...base,
      options: { ...base.options, data: { ...base.options.data, correlationId: 'tag-a' } },
    });
    await NotificationsState.instance.addNotification('tag-b', {
      ...base,
      options: { ...base.options, data: { ...base.options.data, correlationId: 'tag-b' } },
    });

    await NotificationsState.instance.removeNotificationsByTag('key', 'grp');

    expect(storageBackend['pt_notifications']?.['tag-a']).toBeUndefined();
    expect(storageBackend['pt_notifications']?.['tag-b']).toBeUndefined();
    expect(fetchCalls.filter((c) => c.body?.status === 'auto-dismissed').length).toBe(2);
  });
});

describe('Dismiss (3.3b) — chrome.alarms durability + <30s hybrid setTimeout', () => {
  test('a <30s dismiss sets both a clamped alarm AND a precise setTimeout; the alarm firing later is a present-check no-op', async () => {
    Dismiss.instance.registerListeners('key-1');

    activeNotifications.add('short-1');
    await Dismiss.instance.handleTimedAutoDismiss('key-1', 'short-1', { behavior: 'timed', dismissTimeMS: 50 });

    const alarm = alarmsBackend.get('pt-dismiss:short-1');
    expect(alarm).toBeTruthy();
    expect(alarm?.delayInMinutes).toBe(0.5); // clamped floor

    await sleep(150); // let the parallel setTimeout fire first
    expect(activeNotifications.has('short-1')).toBe(false);
    expect(fetchCalls.some((c) => c.body?.correlationId === 'short-1' && c.body?.status === 'auto-dismissed')).toBe(true);
    expect(alarmsBackend.has('pt-dismiss:short-1')).toBe(false); // backstop alarm cleared once the timer wins

    // Present-check: firing onAlarm for a notification that's already gone
    // must be a no-op, not send a second track event.
    fetchCalls.length = 0;
    alarmsOnAlarm.listeners.forEach((l) => l({ name: 'pt-dismiss:short-1' }));
    await sleep(20);
    expect(fetchCalls.length).toBe(0);
  });

  test('a >=30s dismiss uses only the alarm; onAlarm firing (simulated SW restart) dismisses a still-present notification', async () => {
    Dismiss.instance.registerListeners('key-1');

    activeNotifications.add('long-1');
    await Dismiss.instance.handleTimedAutoDismiss('key-1', 'long-1', { behavior: 'timed', dismissTimeMS: 120_000 });

    const alarm = alarmsBackend.get('pt-dismiss:long-1');
    expect(alarm?.delayInMinutes).toBe(2);

    // Simulate the worker being killed and re-woken purely by the alarm.
    alarmsOnAlarm.listeners.forEach((l) => l({ name: 'pt-dismiss:long-1' }));
    await sleep(20);

    expect(activeNotifications.has('long-1')).toBe(false);
    expect(fetchCalls.some((c) => c.body?.correlationId === 'long-1' && c.body?.status === 'auto-dismissed')).toBe(true);
  });

  test('handleNotificationClose clears BOTH the backstop alarm and the pending short setTimeout', async () => {
    Dismiss.instance.registerListeners('key-1');

    activeNotifications.add('closed-early');
    await Dismiss.instance.handleTimedAutoDismiss('key-1', 'closed-early', { behavior: 'timed', dismissTimeMS: 50 });
    expect(alarmsBackend.has('pt-dismiss:closed-early')).toBe(true);

    // User closes/clicks the notification before the dismiss timer fires.
    await Dismiss.instance.handleNotificationClose('closed-early');
    expect(alarmsBackend.has('pt-dismiss:closed-early')).toBe(false);

    fetchCalls.length = 0;
    await sleep(80); // long enough for the (now-cancelled) setTimeout to have fired if it wasn't cleared
    expect(fetchCalls.length).toBe(0);
  });
});

describe('Click path ordering — read-before-clear race', () => {
  test('getNotification is read before chrome.notifications.clear() so link/badge data survives the clear()-triggered onClosed removal', async () => {
    new PushNotifications({ apiKey: 'key-click' });

    const pushPayload = {
      title: 'Hello',
      options: {
        body: 'World',
        icon: 'icon.png',
        data: {
          correlationId: 'click-1',
          autoDismissOptions: { behavior: 'device_default' },
          link: 'https://example.com/deep-link',
          badge: { text: '1', color: '#fff' },
        },
      },
    };
    await pushListeners[pushListeners.length - 1]({
      data: { json: () => pushPayload },
      waitUntil: (p: Promise<any>) => p,
    });
    await sleep(10);
    expect(storageBackend['pt_notifications']?.['click-1']).toBeTruthy();

    notificationsOnClicked.listeners.forEach((l) => l('click-1'));
    await sleep(20); // let the clear() -> onClosed -> removeNotification cascade settle

    // clear() is called synchronously inside the click handler and cascades
    // to onClosed -> NotificationsState.removeNotification in the same flow,
    // but the link/badge were read out BEFORE clear() ran, so they still
    // reached chrome.tabs.create / chrome.action.setBadgeText.
    expect(tabsCreateCalls.some((c) => c.url === 'https://example.com/deep-link')).toBe(true);
    expect(badgeTextCalls).toContain('');
    expect(storageBackend['pt_notifications']?.['click-1']).toBeUndefined(); // cleaned up after
  });
});

describe('Top-level listener wiring (ReceiveNotification.initialize) — MV3 wake-event registration', () => {
  test('Dismiss listeners (onAlarm, onClosed, action.onClicked) ARE registered synchronously at top-level init', () => {
    new PushNotifications({ apiKey: 'key-top' });

    expect(alarmsOnAlarm.listeners.length).toBeGreaterThanOrEqual(1);
    expect(actionOnClicked.listeners.length).toBeGreaterThanOrEqual(1);
    expect(notificationsOnClosed.listeners.length).toBeGreaterThanOrEqual(1); // Dismiss's own onClosed listener
  });

  test('chrome.notifications.onClicked IS registered synchronously at top-level init (W1-G fix)', () => {
    new PushNotifications({ apiKey: 'key-top-2' });

    // PushNotificationEvents.getInstance() (which wires onClicked/onClosed) is
    // now called from ReceiveNotification.initialize() alongside
    // Dismiss.instance.registerListeners(apiKey), so the onClicked listener is
    // registered at top-level SW startup. A worker re-woken purely by a bare
    // notification click therefore has a listener to dispatch to: the click is
    // tracked, the link opens, and the badge clears. This closes the second
    // cause of "post-restart click does nothing" (W1-A fixed the state loss;
    // W1-G fixes the missing listener) so AC1 is fully met.
    expect(notificationsOnClicked.listeners.length).toBeGreaterThanOrEqual(1);
  });
});

describe('Tracking correctness (W1-F) — programmatic clear() must not overwrite CLICKED/AUTO_DISMISSED with CLOSED', () => {
  const statusesFor = (id: string) =>
    fetchCalls.filter((c) => c.body?.correlationId === id).map((c) => c.body?.status);

  async function pushNotification(
    correlationId: string,
    dataOverrides: Record<string, any> = {},
  ) {
    await pushListeners[pushListeners.length - 1]({
      data: {
        json: () => ({
          title: 't',
          options: {
            body: 'b',
            icon: 'i',
            data: {
              correlationId,
              autoDismissOptions: { behavior: 'device_default' },
              ...dataOverrides,
            },
          },
        }),
      },
      waitUntil: (p: Promise<any>) => p,
    });
    await sleep(10);
  }

  test('click → exactly one CLICKED and zero CLOSED; storage entry still GC-removed', async () => {
    new PushNotifications({ apiKey: 'key-f' });
    await pushNotification('f-click', { link: 'https://example.com' });

    notificationsOnClicked.listeners.forEach((l) => l('f-click'));
    await sleep(20); // let clear() -> onClosed cascade settle

    const statuses = statusesFor('f-click');
    expect(statuses.filter((s) => s === 'clicked').length).toBe(1);
    expect(statuses.filter((s) => s === 'closed').length).toBe(0);
    expect(storageBackend['pt_notifications']?.['f-click']).toBeUndefined();
  });

  test('auto-dismiss → exactly one AUTO_DISMISSED and zero CLOSED; storage entry still GC-removed', async () => {
    new PushNotifications({ apiKey: 'key-f' });
    // >=30s dismiss uses the alarm only; fire onAlarm to simulate the dismiss.
    await pushNotification('f-ad', {
      autoDismissOptions: { behavior: 'timed', dismissTimeMS: 120_000 },
    });
    expect(activeNotifications.has('f-ad')).toBe(true);

    alarmsOnAlarm.listeners.forEach((l) => l({ name: 'pt-dismiss:f-ad' }));
    await sleep(20); // fireDismissIfPresent -> handleAutoDismissed -> clear -> onClosed

    const statuses = statusesFor('f-ad');
    expect(statuses.filter((s) => s === 'auto-dismissed').length).toBe(1);
    expect(statuses.filter((s) => s === 'closed').length).toBe(0);
    expect(storageBackend['pt_notifications']?.['f-ad']).toBeUndefined();
  });

  test('genuine user-close (onClosed without a preceding programmatic clear) → CLOSED tracked once; storage entry GC-removed', async () => {
    new PushNotifications({ apiKey: 'key-f' });
    await pushNotification('f-userclose');

    // User closes the notification: onClosed fires with no prior clear() call.
    activeNotifications.delete('f-userclose');
    notificationsOnClosed.listeners.forEach((l) => l('f-userclose', true));
    await sleep(20);

    const statuses = statusesFor('f-userclose');
    expect(statuses.filter((s) => s === 'closed').length).toBe(1);
    expect(storageBackend['pt_notifications']?.['f-userclose']).toBeUndefined();
  });
});
