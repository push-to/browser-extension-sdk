export interface PushSubscriptionOptions {
  /** A push-api key. Use a key with no permissions: it ships in the extension. */
  apiKey: string;
  /** Icon used for every notification; wins over the payload's `data.icon`. */
  defaultNotificationIcon?: string;
  /**
   * push-api host, without `/v1` (the SDK appends it). Overrides the host the
   * package was built with.
   */
  apiBaseUrl?: string;
  /**
   * The platform's VAPID public key (base64url). When omitted the SDK reads
   * it from `GET /v1/vapid-key` on every registration.
   */
  vapidPublicKey?: string;
}

export interface User {
  id?: string;
  email?: string;
  name?: string;
  imageUrl?: string;
  language?: string;
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
      correlationId: string;
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

/** Body of `POST /v1/users`, as far as the SDK fills it. */
export interface UpsertUserBody {
  external_id: string;
  email?: string;
  first_name?: string;
  last_name?: string;
}

/** Body of `POST /v1/users/{id}/endpoints`. */
export interface RegisterEndpointBody {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  metadata: Record<string, string>;
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
