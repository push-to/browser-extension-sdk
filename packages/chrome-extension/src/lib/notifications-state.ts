import { fromStored } from './payload';
import { NormalizedNotification } from './types';

/**
 * Persistent store for in-flight notifications.
 *
 * MV3 service workers are ephemeral: an idle worker is terminated and a fresh
 * instance is spun up to handle the next push/click. An in-memory `Map` does
 * not survive that, so notification metadata is persisted in
 * `chrome.storage.local` and read back on demand. Every method is async as a
 * result. Values are plain objects, so the JSON round-trip performed by
 * `chrome.storage` is lossless.
 *
 * Entries are read through `fromStored`: 0.0.x stored the raw legacy payload
 * under the same key, and those entries must still resolve after an upgrade.
 */
export class NotificationsState {
  private static notificationsState: NotificationsState;
  private static readonly STORAGE_KEY = 'pt_notifications';

  // Each write is read-modify-write of one storage key; run them one at a
  // time so two events handled by the same worker cannot lose an update.
  private queue: Promise<unknown> = Promise.resolve();

  private constructor() {}

  public static get instance() {
    if (!this.notificationsState) {
      this.notificationsState = new NotificationsState();
    }
    return this.notificationsState;
  }

  private serialize<T>(task: () => Promise<T>): Promise<T> {
    const result = this.queue.then(task, task);
    this.queue = result.catch(() => undefined);
    return result;
  }

  private async readAll(): Promise<Record<string, unknown>> {
    const stored = await chrome.storage.local.get(
      NotificationsState.STORAGE_KEY,
    );
    const value = stored[NotificationsState.STORAGE_KEY];
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  }

  private async writeAll(
    notifications: Record<string, unknown>,
  ): Promise<void> {
    await chrome.storage.local.set({
      [NotificationsState.STORAGE_KEY]: notifications,
    });
  }

  public addNotification(
    notificationId: string,
    notification: NormalizedNotification,
  ): Promise<void> {
    return this.serialize(async () => {
      const notifications = await this.readAll();
      notifications[notificationId] = notification;
      await this.writeAll(notifications);
    });
  }

  public removeNotification(notificationId: string): Promise<void> {
    return this.serialize(async () => {
      const notifications = await this.readAll();
      if (notificationId in notifications) {
        delete notifications[notificationId];
        await this.writeAll(notifications);
      }
    });
  }

  public getNotification(
    notificationId: string,
  ): Promise<NormalizedNotification | undefined> {
    return this.serialize(async () => {
      const notifications = await this.readAll();
      return fromStored(notifications[notificationId]);
    });
  }

  /**
   * Removes every entry with this tag except `exceptId`, and returns the ids
   * removed so the caller can clear them from the screen.
   */
  public removeNotificationsByTag(
    tag: string,
    exceptId?: string,
  ): Promise<string[]> {
    return this.serialize(async () => {
      const notifications = await this.readAll();
      const removed: string[] = [];

      for (const [notificationId, stored] of Object.entries(notifications)) {
        if (notificationId !== exceptId && fromStored(stored)?.tag === tag) {
          delete notifications[notificationId];
          removed.push(notificationId);
        }
      }

      if (removed.length > 0) {
        await this.writeAll(notifications);
      }
      return removed;
    });
  }
}
