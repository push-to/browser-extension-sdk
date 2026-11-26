/**
 * Mocked-chrome MV3 durability checks — Phase 3 Wave 1
 * (core/docs/Specs/Phase 3 - PRD.md §Wave 1, items 3.3a/3.3b + AC1), on the
 * push-api payload and feedback shapes.
 *
 * Run: bun test src/lib/__tests__/mv3-durability.test.ts
 * (run from packages/chrome-extension)
 *
 * Excluded from the package's `tsc --noEmit` gate via tsconfig.json's
 * `**\/*.test.ts` exclude (mirroring the existing `**\/*.spec.ts` exclusion) —
 * this project has no `bun` types wired in yet, only `node`/`chrome`.
 *
 * The mocked environment lives in ./test-env.ts. Each test resets both the
 * mock chrome environment AND the modules' private static singletons, so
 * every `test()` starts from a state equivalent to a genuinely fresh MV3
 * service-worker instantiation.
 */

import { beforeEach, describe, expect, test } from 'bun:test';
import { NotificationsState } from '../notifications-state';
import { Dismiss } from '../dismiss';
import { PushNotifications } from '../pushto-chrome-extension';
import { NormalizedNotification } from '../types';
import {
  API_BASE_URL,
  installMocks,
  resetSingletons,
  sleep,
  TestEnv,
} from './test-env';

let env: TestEnv;

beforeEach(() => {
  env = installMocks();
  resetSingletons();
});

function stored(
  id: string,
  extra: Partial<NormalizedNotification> = {},
): NormalizedNotification {
  return {
    v: 2,
    id,
    notificationId: Number(id),
    title: 't',
    message: 'b',
    ...extra,
  };
}

function init(apiKey = 'key') {
  return new PushNotifications({ apiKey, apiBaseUrl: API_BASE_URL });
}

describe('NotificationsState (3.3a) — chrome.storage.local persistence', () => {
  test('write, then a fresh singleton instance backed by the same storage reads it back (simulated SW restart)', async () => {
    await NotificationsState.instance.addNotification(
      '101',
      stored('101', { url: 'https://example.com/' }),
    );
    expect(env.storage['pt_notifications']?.['101']?.notificationId).toBe(101);

    // Simulate the SW restart mid-test: a fresh JS realm resets the static
    // singleton to undefined. env.storage is untouched -- it models
    // chrome.storage.local, which lives in the browser, not the worker.
    (NotificationsState as any).notificationsState = undefined;
    const freshInstance = NotificationsState.instance;

    const got = await freshInstance.getNotification('101');
    expect(got?.notificationId).toBe(101);
    expect(got?.url).toBe('https://example.com/');
  });

  test('removeNotificationsByTag removes all matching entries except the new one and returns their ids', async () => {
    await NotificationsState.instance.addNotification(
      '1',
      stored('1', { tag: 'grp' }),
    );
    await NotificationsState.instance.addNotification(
      '2',
      stored('2', { tag: 'grp' }),
    );
    await NotificationsState.instance.addNotification(
      '3',
      stored('3', { tag: 'other' }),
    );
    await NotificationsState.instance.addNotification(
      '4',
      stored('4', { tag: 'grp' }),
    );

    const removed = await NotificationsState.instance.removeNotificationsByTag(
      'grp',
      '4',
    );

    expect(removed.sort()).toEqual(['1', '2']);
    expect(Object.keys(env.storage['pt_notifications']).sort()).toEqual([
      '3',
      '4',
    ]);
    expect(env.fetchCalls.length).toBe(0);
  });

  test('concurrent writes in one worker do not lose an update', async () => {
    await Promise.all(
      ['1', '2', '3', '4', '5'].map((id) =>
        NotificationsState.instance.addNotification(id, stored(id)),
      ),
    );
    expect(Object.keys(env.storage['pt_notifications']).sort()).toEqual([
      '1',
      '2',
      '3',
      '4',
      '5',
    ]);
  });

  test('state written by 0.0.16 (raw legacy payload) and garbage entries are read without throwing', async () => {
    env.storage['pt_notifications'] = {
      'old-1': {
        title: 'Old',
        options: {
          body: 'b',
          icon: 'i',
          data: {
            correlationId: 'old-1',
            autoDismissOptions: { behavior: 'device_default' },
            link: 'https://example.com/old',
            tag: 'grp',
            badge: { text: '1', color: '#fff' },
          },
        },
      },
      junk: 'not an object',
      nothing: null,
      partial: { title: 'no options' },
    };

    const old = await NotificationsState.instance.getNotification('old-1');
    expect(old?.url).toBe('https://example.com/old');
    expect(old?.notificationId).toBeUndefined();
    expect(
      await NotificationsState.instance.getNotification('junk'),
    ).toBeUndefined();
    expect(
      await NotificationsState.instance.getNotification('nothing'),
    ).toBeUndefined();
    expect(
      await NotificationsState.instance.getNotification('partial'),
    ).toBeUndefined();
    expect(
      await NotificationsState.instance.getNotification('absent'),
    ).toBeUndefined();

    expect(
      await NotificationsState.instance.removeNotificationsByTag('grp'),
    ).toEqual(['old-1']);

    // A value that is not an object at all is treated as empty.
    env.storage['pt_notifications'] = 'corrupt';
    expect(
      await NotificationsState.instance.getNotification('old-1'),
    ).toBeUndefined();
    await NotificationsState.instance.addNotification('5', stored('5'));
    expect(env.storage['pt_notifications']?.['5']?.id).toBe('5');
  });

  test("a click on a notification stored by 0.0.16 still opens its link and is not tracked; its badge, which no marker says is the SDK's, is left alone", async () => {
    env.storage['pt_notifications'] = {
      'old-2': {
        title: 'Old',
        options: {
          body: 'b',
          icon: 'i',
          data: {
            correlationId: 'old-2',
            link: 'https://example.com/old',
            badge: { text: '1', color: '#fff' },
          },
        },
      },
    };
    env.active.set('old-2', {});
    init();

    env.click('old-2');
    await sleep(20);

    expect(env.tabsCreateCalls).toEqual([{ url: 'https://example.com/old' }]);
    // Versions before 1.1 did not record that they set the badge.
    expect(env.badgeTextCalls).toEqual([]);
    expect(env.feedback().length).toBe(0);
    expect(env.storage['pt_notifications']?.['old-2']).toBeUndefined();
  });
});

describe('Dismiss (3.3b) — chrome.alarms durability + <30s hybrid setTimeout', () => {
  test('a <30s dismiss sets both a clamped alarm AND a precise setTimeout; the alarm firing later is a present-check no-op', async () => {
    Dismiss.instance.registerListeners();

    env.active.set('11', {});
    await Dismiss.instance.handleTimedAutoDismiss('11', 50);

    const alarm = env.alarms.get('pt-dismiss:11');
    expect(alarm).toBeTruthy();
    expect(alarm?.delayInMinutes).toBe(0.5); // clamped floor

    await sleep(150); // let the parallel setTimeout fire first
    expect(env.active.has('11')).toBe(false);
    expect(env.alarms.has('pt-dismiss:11')).toBe(false); // backstop alarm cleared once the timer wins

    // Present-check: firing onAlarm for a notification that's already gone
    // must be a no-op.
    env.fireAlarm('pt-dismiss:11');
    await sleep(20);
    expect(env.active.has('11')).toBe(false);
    expect(env.fetchCalls.length).toBe(0); // an auto-dismiss reports nothing
  });

  test('a >=30s dismiss uses only the alarm; onAlarm firing (simulated SW restart) dismisses a still-present notification', async () => {
    Dismiss.instance.registerListeners();

    env.active.set('12', {});
    await Dismiss.instance.handleTimedAutoDismiss('12', 120_000);

    const alarm = env.alarms.get('pt-dismiss:12');
    expect(alarm?.delayInMinutes).toBe(2);

    // Simulate the worker being killed and re-woken purely by the alarm: a
    // fresh realm with nothing but the top-level init.
    resetSingletons();
    env.alarmsOnAlarm.listeners.length = 0;
    env.notificationsOnClosed.listeners.length = 0;
    init();

    env.fireAlarm('pt-dismiss:12');
    await sleep(20);

    expect(env.active.has('12')).toBe(false);
    expect(env.alarms.has('pt-dismiss:12')).toBe(false);
    expect(env.fetchCalls.length).toBe(0);
  });

  test('an alarm that is not ours is ignored', async () => {
    Dismiss.instance.registerListeners();
    env.active.set('13', {});
    env.fireAlarm('someone-elses-alarm:13');
    await sleep(20);
    expect(env.active.has('13')).toBe(true);
  });

  test('handleNotificationClose clears BOTH the backstop alarm and the pending short setTimeout', async () => {
    Dismiss.instance.registerListeners();

    env.active.set('14', {});
    await Dismiss.instance.handleTimedAutoDismiss('14', 50);
    expect(env.alarms.has('pt-dismiss:14')).toBe(true);

    // User closes/clicks the notification before the dismiss timer fires.
    await Dismiss.instance.handleNotificationClose('14');
    expect(env.alarms.has('pt-dismiss:14')).toBe(false);

    await sleep(80); // long enough for the (now-cancelled) setTimeout to have fired if it wasn't cleared
    expect(env.active.has('14')).toBe(true); // the cancelled timer did not clear it
  });
});

describe('Click path ordering — read-before-clear race', () => {
  test('getNotification is read before chrome.notifications.clear() so url/badge data survives the clear()-triggered onClosed removal', async () => {
    init('key-click');

    await env.push({
      title: 'Hello',
      body: 'World',
      notification_id: 21,
      data: {
        url: 'https://example.com/deep-link',
        badge: { text: '1', color: '#fff' },
      },
    });
    expect(env.storage['pt_notifications']?.['21']).toBeTruthy();
    expect(env.badgeTextCalls).toEqual(['1']);
    expect(env.badgeColorCalls).toEqual(['#fff']);

    env.click('21');
    await sleep(20); // let the clear() -> onClosed -> removeNotification cascade settle

    // clear() is called synchronously inside the click handler and cascades
    // to onClosed -> NotificationsState.removeNotification in the same flow,
    // but the url/badge were read out BEFORE clear() ran, so they still
    // reached chrome.tabs.create / chrome.action.setBadgeText.
    expect(
      env.tabsCreateCalls.some(
        (c) => c.url === 'https://example.com/deep-link',
      ),
    ).toBe(true);
    expect(env.badgeTextCalls).toContain('');
    expect(env.storage['pt_notifications']?.['21']).toBeUndefined(); // cleaned up after
  });
});

describe('Top-level listener wiring (ReceiveNotification.initialize) — MV3 wake-event registration', () => {
  test('push, onAlarm, onClosed, onClicked and action.onClicked listeners ARE registered synchronously at top-level init', () => {
    init('key-top');

    // Synchronously: nothing has been awaited since the constructor returned.
    expect(env.pushListeners.length).toBe(1);
    expect(env.alarmsOnAlarm.listeners.length).toBe(1);
    expect(env.actionOnClicked.listeners.length).toBe(1);
    expect(env.notificationsOnClosed.listeners.length).toBe(2); // PushNotificationEvents + Dismiss
    // A worker re-woken purely by a bare notification click has a listener
    // to dispatch to (W1-G fix).
    expect(env.notificationsOnClicked.listeners.length).toBe(1);
  });

  test('a manifest without an `action` key does not break top-level init or a push with a badge', async () => {
    delete (globalThis as any).chrome.action;

    init('key-top');
    expect(env.pushListeners.length).toBe(1);

    await env.push({
      title: 't',
      body: 'b',
      notification_id: 22,
      data: { badge: { text: '1' } },
    });
    expect(env.active.has('22')).toBe(true);
    env.click('22');
    await sleep(20);
    expect(env.feedbackTypes(22)).toEqual(['delivered', 'clicked']);
  });
});

describe('Tracking correctness (W1-F) — a programmatic clear() must never be followed by `dismissed`', () => {
  const push = (notificationId: number, data: Record<string, unknown> = {}) =>
    env.push({ title: 't', body: 'b', notification_id: notificationId, data });

  test('click → exactly one `clicked` and zero `dismissed`; storage entry still GC-removed', async () => {
    init('key-f');
    await push(31, { url: 'https://example.com' });

    env.click('31');
    await sleep(20); // let clear() -> onClosed cascade settle

    const types = env.feedbackTypes(31);
    expect(types.filter((s) => s === 'clicked').length).toBe(1);
    expect(types.filter((s) => s === 'dismissed').length).toBe(0);
    expect(env.storage['pt_notifications']?.['31']).toBeUndefined();
  });

  test('auto-dismiss → nothing reported beyond `delivered`; storage entry still GC-removed', async () => {
    init('key-f');
    // >=30s dismiss uses the alarm only; fire onAlarm to simulate the dismiss.
    await push(32, {
      auto_dismiss: { behavior: 'timed', dismiss_time_ms: 120_000 },
    });
    expect(env.active.has('32')).toBe(true);
    expect(env.alarms.get('pt-dismiss:32')?.delayInMinutes).toBe(2);

    env.fireAlarm('pt-dismiss:32');
    await sleep(20); // fireDismissIfPresent -> clearSilently -> clear -> onClosed

    expect(env.active.has('32')).toBe(false);
    expect(env.feedbackTypes(32)).toEqual(['delivered']);
    expect(env.storage['pt_notifications']?.['32']).toBeUndefined();
  });

  test('a short (<30s) auto-dismiss fires from the setTimeout and reports nothing', async () => {
    init('key-f');
    await push(33, {
      auto_dismiss: { behavior: 'timed', dismiss_time_ms: 30 },
    });
    expect(env.alarms.get('pt-dismiss:33')?.delayInMinutes).toBe(0.5);

    await sleep(100);

    expect(env.active.has('33')).toBe(false);
    expect(env.feedbackTypes(33)).toEqual(['delivered']);
    expect(env.alarms.has('pt-dismiss:33')).toBe(false);
  });

  test('tag replacement → the replaced notification is cleared with no `dismissed`', async () => {
    init('key-f');
    await push(34, { tag: 'score' });
    await push(35, { tag: 'score' });
    await sleep(20);

    expect(env.active.has('34')).toBe(false);
    expect(env.active.has('35')).toBe(true);
    expect(env.feedbackTypes(34)).toEqual(['delivered']);
    expect(env.feedbackTypes(35)).toEqual(['delivered']);
    expect(Object.keys(env.storage['pt_notifications'])).toEqual(['35']);
  });

  test('genuine user-close (onClosed without a preceding programmatic clear) → `dismissed` once; storage entry GC-removed', async () => {
    init('key-f');
    await push(36);

    env.userClose('36');
    await sleep(20);

    expect(env.feedbackTypes(36)).toEqual(['delivered', 'dismissed']);
    expect(env.storage['pt_notifications']?.['36']).toBeUndefined();
  });

  test('user-close of a notification that was already auto-dismiss-scheduled cancels the alarm', async () => {
    init('key-f');
    await push(37, {
      auto_dismiss: { behavior: 'timed', dismiss_time_ms: 120_000 },
    });
    expect(env.alarms.has('pt-dismiss:37')).toBe(true);

    env.userClose('37');
    await sleep(20);

    expect(env.alarms.has('pt-dismiss:37')).toBe(false);
    expect(env.feedbackTypes(37)).toEqual(['delivered', 'dismissed']);
  });
});
