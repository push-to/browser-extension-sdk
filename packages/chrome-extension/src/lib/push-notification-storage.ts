import { User } from './types';

/** What the last successful registration sent; see `RegisterSubscription`. */
export interface StoredRegistration {
  /** SHA-256 of everything the registration call depends on. */
  fingerprint: string;
  /** `Date.now()` of that registration. */
  registeredAt: number;
  /**
   * What push-api answered, the external id sent, and the SHA-256 of the
   * subscription's address and both of its keys. An entry written by 1.0.0
   * has none of them.
   */
  userId?: number;
  endpointId?: number;
  externalId?: string;
  subscriptionHash?: string;
}

/**
 * The identity last asked for with `identify` / `reset` /
 * `registerPushSubscription`. It is kept in two places:
 *
 * - `chrome.storage.local` holds the external id only (none for the
 *   anonymous subscriber) and whether more than the id was given. That is
 *   what the user-change check and the delivery gate need, and it has to
 *   survive a browser restart.
 * - `chrome.storage.session` holds the fields themselves (`hash`, `email`,
 *   `name`, `imageUrl`, `language`). `storage.local` is readable by the
 *   extension's content scripts and is written to disk unencrypted, and the
 *   hash is a proof that does not expire; `storage.session` is for trusted
 *   contexts only by default, survives a worker restart and is gone when the
 *   browser closes. Where it does not exist the fields are kept in memory.
 */
export interface RememberedIdentity {
  /** The external id of an identified user; absent for the anonymous one. */
  id?: string;
  /** The user to register for it: everything that is still known. */
  user?: User;
  /**
   * More than the id was given, and it is gone (the browser was restarted
   * since). A registration made now could be refused for the missing hash,
   * or create the user without its email: only an explicit call makes it.
   */
  detailsLost: boolean;
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
const IDENTITY_KEY = 'pt_identity';
const OPTED_OUT_KEY = 'pt_optedOut';

/** Why a push that arrives now is not displayed; see `deliveryBlock`. */
export type DeliveryBlock = 'opted_out' | 'identity_change_pending';

function sameUser(a: User | undefined, b: User | undefined) {
  return USER_FIELDS.every((field) => a?.[field] === b?.[field]);
}

const USER_FIELDS = [
  'id',
  'hash',
  'email',
  'name',
  'imageUrl',
  'language',
] as const;

/**
 * Only the known members, and only strings (or a numeric id that is a safe
 * integer; see `assertSafeId`).
 */
function toStoredUser(user: unknown): User | undefined {
  if (!user || typeof user !== 'object') {
    return undefined;
  }
  const stored: Record<string, unknown> = {};
  for (const field of USER_FIELDS) {
    const value = (user as Record<string, unknown>)[field];
    if (
      typeof value === 'string' ||
      (field === 'id' && Number.isSafeInteger(value))
    ) {
      stored[field] = value;
    }
  }
  return Object.keys(stored).length > 0 ? (stored as User) : undefined;
}

/**
 * The external id an identified `User` is registered under: a string `id`
 * with its surrounding whitespace removed, a safe integer as its decimal
 * string. `undefined` for an anonymous subscriber.
 */
export function identifiedId(user: User | undefined): string | undefined {
  const id: unknown = user?.id;
  if (Number.isSafeInteger(id)) {
    return String(id);
  }
  return typeof id === 'string' && id.trim() ? id.trim() : undefined;
}

/**
 * Throws a `TypeError` for a numeric `id` that is not a safe integer. That
 * is a caller error, not an anonymous subscriber: a number above
 * `Number.MAX_SAFE_INTEGER` was rounded before the SDK saw it, so two users
 * would share one external id, and the decimal string of any other
 * (`"1.5"`, `"1e+21"`, `"NaN"`) is not an id the integrator's server signed.
 * Every registration with a `User` from the caller checks this first, so
 * `identifiedId` and `toStoredUser` never meet such a number.
 */
export function assertSafeId(user: User | undefined): void {
  const id: unknown = user?.id;
  if (typeof id === 'number' && !Number.isSafeInteger(id)) {
    throw new TypeError(
      'PushNotifications: a numeric `user.id` must be a safe integer (Number.isSafeInteger). Pass the id as a string: JavaScript has already rounded a larger number, so two users could be registered under the same id.',
    );
  }
}

/** `chrome.storage.session`, where the runtime has it. */
function sessionArea(): chrome.storage.StorageArea | undefined {
  return (chrome.storage as { session?: chrome.storage.StorageArea }).session;
}

export class PushNotificationStorage {
  /** Stands in for `chrome.storage.session` where that does not exist. */
  private static memoryDetails?: User;

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
    if (
      typeof value?.fingerprint !== 'string' ||
      typeof value.registeredAt !== 'number'
    ) {
      return undefined;
    }
    const registration: StoredRegistration = {
      fingerprint: value.fingerprint,
      registeredAt: value.registeredAt,
    };
    if (typeof value.userId === 'number') {
      registration.userId = value.userId;
    }
    if (typeof value.endpointId === 'number') {
      registration.endpointId = value.endpointId;
    }
    if (typeof value.externalId === 'string') {
      registration.externalId = value.externalId;
    }
    if (typeof value.subscriptionHash === 'string') {
      registration.subscriptionHash = value.subscriptionHash;
    }
    return registration;
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

  /** Forgets the registration, so the next call registers in full. */
  public static async clearRegistration(): Promise<void> {
    await chrome.storage.local.remove(REGISTRATION_KEY);
  }

  /** Both caches in one call, so that one cannot go without the other. */
  public static async clearRegistrationAndVapidKey(): Promise<void> {
    await chrome.storage.local.remove([REGISTRATION_KEY, VAPID_KEY]);
  }

  private static async readDetails(): Promise<User | undefined> {
    const session = sessionArea();
    if (!session) {
      return this.memoryDetails;
    }
    try {
      const stored = await session.get(IDENTITY_KEY);
      return toStoredUser(
        (stored[IDENTITY_KEY] as { user?: unknown } | undefined)?.user,
      );
    } catch {
      return this.memoryDetails;
    }
  }

  private static async writeDetails(user: User | undefined): Promise<void> {
    this.memoryDetails = user;
    const session = sessionArea();
    if (!session) {
      return;
    }
    try {
      if (user) {
        await session.set({ [IDENTITY_KEY]: { user } });
      } else {
        await session.remove(IDENTITY_KEY);
      }
    } catch {
      // kept in memory for this worker
    }
  }

  /** `undefined`: no registration was ever asked for. */
  public static async getIdentity(): Promise<RememberedIdentity | undefined> {
    const stored = await chrome.storage.local.get(IDENTITY_KEY);
    const value = stored[IDENTITY_KEY] as
      | { id?: unknown; details?: unknown }
      | undefined;
    if (!value || typeof value !== 'object') {
      return undefined;
    }
    const id = typeof value.id === 'string' && value.id ? value.id : undefined;
    const identity: RememberedIdentity = { detailsLost: false };
    if (id !== undefined) {
      identity.id = id;
      identity.user = { id };
    }
    if (value.details === true) {
      const details = await this.readDetails();
      // Details of another identity are not this one's.
      if (details && identifiedId(details) === id) {
        identity.user = details;
      } else {
        identity.detailsLost = true;
      }
    }
    return identity;
  }

  /**
   * Stores the identity, writing only what changed. Resolves to the
   * identity that was stored before.
   */
  public static async replaceIdentity(
    user: User | undefined,
  ): Promise<RememberedIdentity | undefined> {
    const next = toStoredUser(user);
    const id = identifiedId(next);
    const details =
      next !== undefined &&
      USER_FIELDS.some((field) => field !== 'id' && next[field] !== undefined);

    const stored = await chrome.storage.local.get(IDENTITY_KEY);
    const raw = stored[IDENTITY_KEY] as
      | { id?: unknown; details?: unknown }
      | undefined;
    const previous = await this.getIdentity();

    // The fields first: if this fails nothing was changed.
    if (!details) {
      if ((await this.readDetails()) !== undefined) {
        await this.writeDetails(undefined);
      }
    } else if (!sameUser(await this.readDetails(), next)) {
      await this.writeDetails(next);
    }
    if (
      !previous ||
      previous.id !== id ||
      (raw?.details === true) !== details
    ) {
      const value: { id?: string; details?: true } = {};
      if (id !== undefined) {
        value.id = id;
      }
      if (details) {
        value.details = true;
      }
      await chrome.storage.local.set({ [IDENTITY_KEY]: value });
    }
    return previous;
  }

  /**
   * Whether a push that arrives now must not be displayed:
   *
   * - `opted_out`: `unsubscribe()` was called and `subscribe()` not since.
   * - `identity_change_pending`: the identity asked for is not the one the
   *   API last confirmed. Either a sign-out or a switch of user is still
   *   waiting for the API, or there is no cached registration at all: the
   *   first one has not succeeded yet, or the cache was deleted
   *   (`unsubscribe()`, a removed permission) and no registration has
   *   succeeded since. In both cases what arrives is addressed to whoever
   *   was registered before: nothing for the identity asked for can arrive
   *   before its registration succeeds. Not applied when a side is unknown:
   *   no identity was ever asked for, or the registration was cached by
   *   1.0.0, which did not store whom it was for.
   */
  public static async deliveryBlock(): Promise<DeliveryBlock | undefined> {
    if (await this.isOptedOut()) {
      return 'opted_out';
    }
    const [identity, registration] = await Promise.all([
      this.getIdentity(),
      this.getRegistration(),
    ]);
    if (!identity) {
      return undefined;
    }
    if (!registration) {
      return 'identity_change_pending';
    }
    if (registration.externalId === undefined) {
      return undefined;
    }
    const wanted = identity.id ?? `anon:${await this.getAnonymousId()}`;
    return wanted === registration.externalId
      ? undefined
      : 'identity_change_pending';
  }

  public static async isOptedOut(): Promise<boolean> {
    const stored = await chrome.storage.local.get(OPTED_OUT_KEY);
    return stored[OPTED_OUT_KEY] === true;
  }

  public static async setOptedOut(optedOut: boolean): Promise<void> {
    if (optedOut) {
      await chrome.storage.local.set({ [OPTED_OUT_KEY]: true });
    } else {
      await chrome.storage.local.remove(OPTED_OUT_KEY);
    }
  }
}
