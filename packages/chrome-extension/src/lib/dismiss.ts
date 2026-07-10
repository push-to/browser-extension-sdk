import { PushNotificationEvents } from './push-notification-events';
import { AutoDismissOptions } from './types';

const ALARM_PREFIX = 'pt-dismiss:';

/**
 * Chrome clamps alarm delays below 30s (0.5 min) to 30s. For shorter dismiss
 * times we run a precise `setTimeout` while the worker is alive and keep the
 * (clamped) alarm as a durability backstop in case the worker is terminated
 * before the timeout fires.
 */
const MIN_ALARM_DELAY_MS = 30_000;

/**
 * Schedules `timed` auto-dismissals durably across MV3 service-worker
 * termination.
 *
 * A `setTimeout` timer dies when the worker is killed, so the source of truth
 * is `chrome.alarms`: an alarm persists and re-wakes a fresh worker to fire.
 * Because the re-woken worker did not schedule the alarm, the `onAlarm`
 * listener must be registered at top-level SW startup — this class exposes
 * {@link registerListeners} for `ReceiveNotification` to call during
 * initialization.
 */
export class Dismiss {
  private static dismiss: Dismiss;
  private shortTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private apiKey?: string;
  private listenersRegistered = false;

  private constructor() {}

  public static get instance() {
    if (!this.dismiss) {
      this.dismiss = new Dismiss();
    }
    return this.dismiss;
  }

  /**
   * Register the top-level `onAlarm`/`onClosed` listeners. Called on every SW
   * startup so a worker re-woken by an alarm it never scheduled still handles
   * it. Idempotent — the listeners are added at most once per worker instance.
   */
  public registerListeners(apiKey: string) {
    this.apiKey = apiKey;

    if (this.listenersRegistered) {
      return;
    }
    this.listenersRegistered = true;

    chrome.alarms.onAlarm.addListener((alarm) => {
      if (!alarm.name.startsWith(ALARM_PREFIX)) {
        return;
      }
      const correlationId = alarm.name.slice(ALARM_PREFIX.length);
      void this.fireDismissIfPresent(correlationId);
    });

    // When a notification is closed/clicked before its dismiss time, cancel the
    // pending alarm so it doesn't needlessly re-wake the worker later.
    chrome.notifications.onClosed.addListener((notificationId) => {
      void this.handleNotificationClose(notificationId);
    });
  }

  public async handleTimedAutoDismiss(
    apiKey: string,
    correlationId: string,
    autoDismissOptions: AutoDismissOptions,
  ) {
    if (autoDismissOptions?.behavior !== 'timed') {
      return;
    }

    this.apiKey = apiKey;
    const delayMs = autoDismissOptions.dismissTimeMS;

    // Durable backstop: survives worker termination. Sub-30s delays are clamped
    // by Chrome, so schedule at the floor and let the setTimeout below handle
    // the precise short-delay case while the worker is alive.
    await chrome.alarms.create(ALARM_PREFIX + correlationId, {
      delayInMinutes: Math.max(delayMs, MIN_ALARM_DELAY_MS) / 60_000,
    });

    if (delayMs < MIN_ALARM_DELAY_MS) {
      const timer = setTimeout(() => {
        this.shortTimers.delete(correlationId);
        void this.fireDismissIfPresent(correlationId);
      }, delayMs);
      this.shortTimers.set(correlationId, timer);
    }
  }

  public async handleNotificationClose(correlationId: string) {
    await chrome.alarms.clear(ALARM_PREFIX + correlationId);

    const timer = this.shortTimers.get(correlationId);
    if (timer) {
      clearTimeout(timer);
      this.shortTimers.delete(correlationId);
    }
  }

  /**
   * Dismiss the notification only if it is still on screen. The existence check
   * makes this idempotent: whichever of the setTimeout or the alarm fires first
   * dismisses and clears the notification; a later firing finds it gone and
   * no-ops. Scheduling artifacts are always cleaned up.
   */
  private async fireDismissIfPresent(correlationId: string) {
    const isPresent = (await this.getActiveNotificationIds()).includes(
      correlationId,
    );

    await this.handleNotificationClose(correlationId);

    if (isPresent && this.apiKey) {
      PushNotificationEvents.getInstance(this.apiKey).handleAutoDismissed(
        correlationId,
      );
    }
  }

  private async getActiveNotificationIds(): Promise<string[]> {
    return new Promise((resolve) => {
      chrome.notifications.getAll((notificationsObj) => {
        resolve(Object.keys(notificationsObj ?? {}));
      });
    });
  }
}
