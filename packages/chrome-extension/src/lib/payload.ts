import { NormalizedNotification, NotificationBadge } from './types';

/**
 * 1x1 transparent PNG. `chrome.notifications` refuses a `basic` notification
 * without an `iconUrl`, so this is what is left when nothing else is.
 */
export const FALLBACK_ICON =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNgAAIAAAUAAen63NgAAAAASUVORK5CYII=';

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function urlWithProtocol(
  value: unknown,
  protocols: string[],
): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  try {
    const url = new URL(value);
    return protocols.includes(url.protocol) ? url.href : undefined;
  } catch {
    // relative, or not a URL at all
    return undefined;
  }
}

/**
 * The click target, if it may be opened. `data.url` is whatever the sender
 * set and push-api does not check it, so only an absolute `http:` or `https:`
 * URL gets through: no `javascript:`, `chrome:`, `file:` or relative URL.
 */
export function safeHttpUrl(value: unknown): string | undefined {
  return urlWithProtocol(value, ['http:', 'https:']);
}

function badge(value: unknown): NotificationBadge | undefined {
  if (!isObject(value) || typeof value.text !== 'string') {
    return undefined;
  }
  const color = text(value.color);
  return color ? { text: value.text, color } : { text: value.text };
}

/** Drops absent members, so the persisted object has no `undefined`. */
function compact(notification: NormalizedNotification): NormalizedNotification {
  const entries = Object.entries(notification).filter(
    ([, value]) => value !== undefined,
  );
  return Object.fromEntries(entries) as unknown as NormalizedNotification;
}

function fromPushApi(
  raw: Record<string, unknown>,
): NormalizedNotification | undefined {
  const notificationId = raw.notification_id;
  if (
    typeof raw.title !== 'string' ||
    typeof notificationId !== 'number' ||
    !Number.isSafeInteger(notificationId) ||
    notificationId <= 0
  ) {
    return undefined;
  }
  const data = isObject(raw.data) ? raw.data : {};
  const autoDismiss = isObject(data.auto_dismiss) ? data.auto_dismiss : {};
  const dismissMs = autoDismiss.dismiss_time_ms;

  return compact({
    v: 2,
    id: String(notificationId),
    notificationId,
    title: raw.title,
    message: typeof raw.body === 'string' ? raw.body : '',
    icon: urlWithProtocol(data.icon, ['https:']),
    contextMessage: text(data.context_message),
    url: safeHttpUrl(data.url),
    badge: badge(data.badge),
    tag: text(data.tag),
    autoDismissMs:
      autoDismiss.behavior === 'timed' &&
      typeof dismissMs === 'number' &&
      Number.isFinite(dismissMs) &&
      dismissMs > 0
        ? dismissMs
        : undefined,
  });
}

function fromLegacy(
  raw: Record<string, unknown>,
): NormalizedNotification | undefined {
  const options = raw.options;
  if (typeof raw.title !== 'string' || !isObject(options)) {
    return undefined;
  }
  const data = options.data;
  if (!isObject(data)) {
    return undefined;
  }
  const id =
    typeof data.correlationId === 'number'
      ? String(data.correlationId)
      : text(data.correlationId);
  if (!id) {
    return undefined;
  }
  const autoDismiss = isObject(data.autoDismissOptions)
    ? data.autoDismissOptions
    : {};
  const dismissMs = autoDismiss.dismissTimeMS;

  return compact({
    v: 2,
    id,
    title: raw.title,
    message: typeof options.body === 'string' ? options.body : '',
    icon: text(options.icon),
    contextMessage: text(options.contextMessage),
    url: safeHttpUrl(data.link),
    badge: badge(data.badge),
    tag: text(data.tag),
    autoDismissMs:
      autoDismiss.behavior === 'timed' &&
      typeof dismissMs === 'number' &&
      Number.isFinite(dismissMs) &&
      dismissMs > 0
        ? dismissMs
        : undefined,
    requireInteraction:
      autoDismiss.behavior === 'device_default' ? true : undefined,
  });
}

/**
 * Reduces a push message to the one model the SDK acts on. Accepts push-api's
 * `{ title, body, data, notification_id }` and the legacy
 * `{ title, options: { ..., data: { correlationId } } }`. Anything else is
 * `undefined`; this never throws.
 */
export function normalizePayload(
  raw: unknown,
): NormalizedNotification | undefined {
  if (!isObject(raw)) {
    return undefined;
  }
  return 'notification_id' in raw ? fromPushApi(raw) : fromLegacy(raw);
}

/**
 * Reads back a persisted notification. An entry written by 0.0.x is the raw
 * legacy payload, so it goes through {@link normalizePayload}.
 */
export function fromStored(raw: unknown): NormalizedNotification | undefined {
  if (
    isObject(raw) &&
    raw.v === 2 &&
    typeof raw.id === 'string' &&
    typeof raw.title === 'string'
  ) {
    return raw as unknown as NormalizedNotification;
  }
  return normalizePayload(raw);
}

function largestManifestIcon(): string | undefined {
  try {
    const icons = chrome.runtime.getManifest().icons ?? {};
    const sizes = Object.keys(icons)
      .map(Number)
      .filter((size) => Number.isFinite(size))
      .sort((a, b) => b - a);
    const path = sizes.length
      ? (icons as Record<string, string>)[String(sizes[0])]
      : undefined;
    return path ? chrome.runtime.getURL(path) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Icons to try, best first: the constructor's default, the payload's, the
 * extension's largest manifest icon, then {@link FALLBACK_ICON}.
 */
export function iconCandidates(
  defaultIcon: string | undefined,
  payloadIcon: string | undefined,
): string[] {
  const candidates = [
    text(defaultIcon),
    payloadIcon,
    largestManifestIcon(),
    FALLBACK_ICON,
  ].filter((icon): icon is string => icon !== undefined);
  return [...new Set(candidates)];
}
