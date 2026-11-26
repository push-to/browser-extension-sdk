export interface PushSubscriptionOptions {
  /** A push-api key. Use a key with no permissions: it ships in the extension. */
  apiKey: string;
  /** Icon used for every notification; wins over the payload's `data.icon`. */
  defaultNotificationIcon?: string;
  /**
   * push-api host, without `/v1` (the SDK appends it). Overrides the host the
   * package was built with. Must be an `https:` URL with no query or fragment;
   * `http:` is accepted for loopback hosts only (`localhost`, `*.localhost`,
   * `127.0.0.1`, `[::1]`), because the key travels in a header. Anything else
   * throws from the constructor.
   */
  apiBaseUrl?: string;
  /**
   * The platform's VAPID public key (base64url). When omitted the SDK reads
   * it from `GET /v1/vapid-key` on every registration.
   */
  vapidPublicKey?: string;
}

export interface User {
  /**
   * Your own id for the signed-in user; sent as push-api's `external_id` (a
   * number as its decimal string). Required by `identify`. Without it the
   * subscriber is anonymous.
   */
  id?: string | number;
  /**
   * Identity proof (`user_hash`) for `id`, computed by **your server**:
   * `hex(HMAC-SHA256(identity_secret, id))`, over the `id` exactly as the SDK
   * sends it: a string trimmed of surrounding whitespace, a number as its
   * decimal string, nothing else changed. Required when the tenant has
   * identity verification on. Without an `id` it is dropped, with a
   * `console.warn`. Never compute it in the extension: the secret must not
   * ship.
   */
  hash?: string;
  email?: string;
  name?: string;
  imageUrl?: string;
  language?: string;
}

export type RegistrationStatus =
  /** push-api was called and accepted the registration. */
  | 'registered'
  /** Nothing changed since a registration under 24 hours old: no request. */
  | 'unchanged'
  /**
   * The extension does not hold the `notifications` permission, so nothing
   * was subscribed or sent. The identity is remembered, and the SDK registers
   * by itself when the permission is granted. The exception: an identity
   * given with more than an `id` (`hash`, `email`, …) after the browser has
   * restarted. Those fields are kept for the browser session only, so the
   * SDK does not register without them; the application's `identify` at
   * startup does.
   */
  | 'permission_required'
  /**
   * `unsubscribe()` was called and `subscribe()` not since. Nothing was
   * subscribed or sent; the identity is remembered for `subscribe()`.
   */
  | 'unsubscribed';

export interface RegistrationResult {
  status: RegistrationStatus;
  /** push-api's id of the user. Absent for `permission_required` and `unsubscribed`. */
  userId?: number;
  /** push-api's id of this browser's endpoint. Absent for the same two. */
  endpointId?: number;
  /** The external id registered or asked for: the user's id, or `anon:<anonymousId>`. */
  externalId: string;
}

/** What `getState()` resolves to. Read locally: no request is made. */
export interface PushState {
  /** Whether the extension holds the `notifications` permission right now. */
  permission: 'granted' | 'missing';
  /** The browser has a push subscription (`pushManager.getSubscription()`). */
  subscribed: boolean;
  /**
   * That subscription was registered with push-api less than 24 hours ago,
   * as far as this browser remembers. It does not ask the server.
   */
  registered: boolean;
  /** `unsubscribe()` was called and `subscribe()` not since. */
  optedOut: boolean;
  /**
   * Set while a push that arrives is not displayed: `opted_out` after
   * `unsubscribe()`; `identity_change_pending` while the identity last asked
   * for (`identify` / `reset`) is not the one the API last confirmed. That
   * is a sign-out or a switch of user the API has not confirmed, and also an
   * identity whose first registration has not succeeded yet (as with
   * `status: 'permission_required'`); it lasts for as long as that call
   * keeps failing. Absent when notifications are displayed normally.
   */
  deliveryBlocked?: 'opted_out' | 'identity_change_pending';
  /** push-api's ids from the last registration; only when `registered`. */
  userId?: number;
  endpointId?: number;
  /**
   * The external id of the last registration when `registered`; otherwise
   * the one last asked for, if any.
   */
  externalId?: string;
  /** The random id this browser registers under when no user is given. */
  anonymousId: string;
  /** ISO 8601 time of the last registration; only when `registered`. */
  registeredAt?: string;
  /** The API root in use, ending in `/v1`. */
  apiBaseUrl: string;
  sdkVersion: string;
}

export interface NotificationBadge {
  text: string;
  color?: string;
}

export interface NotificationAutoDismiss {
  behavior: 'timed';
  dismiss_time_ms: number;
}

/**
 * What the SDK reads from a notification's `data`. Every member is optional,
 * and one of the wrong type is ignored. Other members are left alone.
 */
export interface NotificationDisplayData {
  /** Opened in a new tab on click. Only `http:` and `https:` URLs are opened. */
  url?: string;
  /** `https:` URL of the notification icon. */
  icon?: string;
  context_message?: string;
  /** Toolbar badge set when the notification is shown, cleared on click. */
  badge?: NotificationBadge;
  /** A new notification replaces the ones on screen with the same tag. */
  tag?: string;
  auto_dismiss?: NotificationAutoDismiss;
  [key: string]: unknown;
}

/** The push message push-api sends. */
export interface PushApiPayload {
  title: string;
  body: string | null;
  data: NotificationDisplayData;
  notification_id: number;
}

/**
 * The push message of the backend before push-api. Still displayed, so that
 * subscriptions it holds keep working during the cutover, but never tracked.
 */
export interface LegacyPushPayload {
  title: string;
  options: {
    body?: string;
    icon?: string;
    contextMessage?: string;
    data: {
      /** A number is shown under its decimal string. */
      correlationId: string | number;
      link?: string;
      badge?: NotificationBadge;
      tag?: string;
      autoDismissOptions?: { behavior?: string; dismissTimeMS?: number };
    };
  };
}

export type PushPayload = PushApiPayload | LegacyPushPayload;

export type FeedbackEventType =
  | 'delivered'
  | 'opened'
  | 'clicked'
  | 'dismissed'
  | 'session_started'
  | 'opt_out';

/** Body of `POST /v1/feedback`. */
export interface FeedbackEvent {
  notification_id: number;
  event_type: FeedbackEventType;
  /**
   * RFC 3339. The SDK leaves it out, so push-api stamps the event with its
   * own clock: a device whose clock is off would have its events refused.
   */
  occurred_at?: string;
}

/** The user part of the `POST /v1/subscriptions` body. */
export interface SubscriptionUserFields {
  external_id: string;
  /** Only with an identified `external_id`; see `User.hash`. */
  user_hash?: string;
  email?: string;
  first_name?: string;
  last_name?: string;
}

/** `PushSubscription.toJSON()`. push-api ignores `expirationTime`. */
export interface SubscriptionJson {
  endpoint: string;
  expirationTime: number | null;
  keys: { p256dh: string; auth: string };
}

/** Body of `POST /v1/subscriptions`, as far as the SDK fills it. */
export interface RegisterSubscriptionBody extends SubscriptionUserFields {
  subscription: SubscriptionJson;
  metadata: Record<string, string>;
}

/** Body of `DELETE /v1/subscriptions` and `POST /v1/subscriptions/test`. */
export interface SubscriptionOnlyBody {
  subscription: SubscriptionJson;
}

/**
 * Both payload shapes reduced to what the SDK acts on. This is also what is
 * persisted for a notification on screen.
 */
export interface NormalizedNotification {
  /** Marks the persisted shape; entries without it were written by 0.0.x. */
  v: 2;
  /** The `chrome.notifications` id. */
  id: string;
  /** push-api's id. Absent for a legacy payload, which is never tracked. */
  notificationId?: number;
  title: string;
  message: string;
  icon?: string;
  contextMessage?: string;
  /** Already checked to be `http:` or `https:`. */
  url?: string;
  badge?: NotificationBadge;
  tag?: string;
  autoDismissMs?: number;
  requireInteraction?: boolean;
}
