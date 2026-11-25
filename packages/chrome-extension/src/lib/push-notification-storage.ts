/** What the last successful registration sent; see `RegisterSubscription`. */
export interface StoredRegistration {
  /** SHA-256 of everything the two registration calls depend on. */
  fingerprint: string;
  /** `Date.now()` of that registration. */
  registeredAt: number;
}

/** The VAPID public key last read from `GET /v1/vapid-key`. */
export interface StoredVapidKey {
  publicKey: string;
  /** The API it was read from (ends in `/v1`). */
  baseUrl: string;
  fetchedAt: number;
}

const ANONYMOUS_ID_KEY = 'pt_anonymousId';
const REGISTRATION_KEY = 'pt_registration';
const VAPID_KEY = 'pt_vapidKey';

export class PushNotificationStorage {
  // Memoised per worker: two first calls at the same time would otherwise
  // each generate an id, and one of them would register a user this device
  // never uses again.
  private static anonymousId?: Promise<string>;

  public static getAnonymousId(): Promise<string> {
    if (!this.anonymousId) {
      const pending = this.readOrCreateAnonymousId();
      this.anonymousId = pending;
      // A failed read is not remembered.
      pending.catch(() => {
        if (this.anonymousId === pending) {
          this.anonymousId = undefined;
        }
      });
    }
    return this.anonymousId;
  }

  private static async readOrCreateAnonymousId(): Promise<string> {
    const stored = await chrome.storage.local.get(ANONYMOUS_ID_KEY);
    const existing = stored[ANONYMOUS_ID_KEY];
    if (typeof existing === 'string' && existing) {
      return existing;
    }

    const anonymousId = globalThis.crypto.randomUUID();
    await chrome.storage.local.set({ [ANONYMOUS_ID_KEY]: anonymousId });
    return anonymousId;
  }

  public static async getRegistration(): Promise<
    StoredRegistration | undefined
  > {
    const stored = await chrome.storage.local.get(REGISTRATION_KEY);
    const value = stored[REGISTRATION_KEY] as
      | Partial<StoredRegistration>
      | undefined;
    return typeof value?.fingerprint === 'string' &&
      typeof value.registeredAt === 'number'
      ? { fingerprint: value.fingerprint, registeredAt: value.registeredAt }
      : undefined;
  }

  public static async setRegistration(
    registration: StoredRegistration,
  ): Promise<void> {
    await chrome.storage.local.set({ [REGISTRATION_KEY]: registration });
  }

  public static async getVapidKey(): Promise<StoredVapidKey | undefined> {
    const stored = await chrome.storage.local.get(VAPID_KEY);
    const value = stored[VAPID_KEY] as Partial<StoredVapidKey> | undefined;
    return typeof value?.publicKey === 'string' &&
      typeof value.baseUrl === 'string' &&
      typeof value.fetchedAt === 'number'
      ? {
          publicKey: value.publicKey,
          baseUrl: value.baseUrl,
          fetchedAt: value.fetchedAt,
        }
      : undefined;
  }

  public static async setVapidKey(key: StoredVapidKey): Promise<void> {
    await chrome.storage.local.set({ [VAPID_KEY]: key });
  }
}
