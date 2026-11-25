# Push To Chrome Extension

<div align="center"><strong>Push To Chrome Extension</strong></div>
<div align="center">A modern way to handle push notifications in Chrome Extensions.<br />Simple, type-safe, and easy to integrate.</div>
<br />

## Introduction

A TypeScript library for handling push notifications in Chrome Extensions with ease. It takes care of service worker registration, push subscription management, and provides a clean API for handling notifications.

## Features

- 🔄 Automatic service worker registration and push subscription management
- 🚚 Handle push notifications in the background script
- 📝 TypeScript support out of the box
- 🔑 Anonymous user identification
- 💪 Promise-based API
- 🌐 Cross-origin support

## Install

Install the package from your command line:

```sh
# With npm
npm install @push-to/chrome-extension

# With pnpm
pnpm add @push-to/chrome-extension

# With yarn
yarn add @push-to/chrome-extension
```

## Getting Started

1. Declare the service worker and the required permissions in your `manifest.json`.

The SDK persists notification state with `chrome.storage.local`, schedules
durable auto-dismissals with `chrome.alarms`, and shows/clears notifications
with `chrome.notifications`, so it needs the `storage`, `alarms`, and
`notifications` permissions. It must run in the extension's background service
worker (Manifest V3).

```json
// manifest.json
{
  "manifest_version": 3,
  "background": {
    "service_worker": "background.js",
    "type": "module"
  },
  "permissions": ["notifications", "alarms", "storage"],
  "action": {}
}
```

> `chrome.tabs.create` (used to open a notification's link) does **not** require
> the `tabs` permission. The `"action": {}` key is optional: with it the SDK
> can set/clear the toolbar badge (a notification's `data.badge`); without it
> badges are skipped and everything else works.
>
> `host_permissions` for the Push To API are **optional**: the API answers
> cross-origin requests (CORS, any origin) on every route the SDK calls, so the
> service worker can reach it without them.

2. Initialize the Push To extension at the **top level** of your background
service worker.

> ⚠️ **`new PushNotifications(...)` must run synchronously at the top level of
> the service worker — not inside another event callback** (e.g. not inside
> `chrome.runtime.onInstalled`). This is required by MV3's ephemeral worker
> model:
> - MV3 only delivers wake events (`push`, `alarm`, notification clicks) to
>   listeners that were registered **synchronously at worker startup**. A
>   worker re-woken by an auto-dismiss alarm re-runs its top-level code, so the
>   SDK's listeners must be registered there or the wake is lost.
> - The API key is held in memory and is only re-hydrated when initialization
>   runs at startup. Initializing lazily would leave a worker re-woken by a
>   notification click or close unable to report it.

```typescript
// background.js — runs at the top level of the service worker

import { PushNotifications } from '@push-to/chrome-extension';

const pushTo = new PushNotifications({
  apiKey: 'your-browser-api-key',
  // Optional: default icon used for every notification
  defaultNotificationIcon: 'https://example.com/icon.png'
});
```

> 🔑 **Use a key with no permissions.** The key ships inside your extension,
> so anyone can read it. A Push To API key without the `sending` / `admin`
> permission cannot send a notification, list your users, or read or change
> segments, campaigns, items and opportunities. Keep your sending key on your
> server.
>
> What such a key **can** do: read the VAPID public key, report feedback, and
> create or update a user by its `external_id` (the `id` you pass to
> `registerPushSubscription`) — and the API answers that call with the user's
> stored row. Anyone holding the key who can guess a user's id can therefore
> read and overwrite that user's email, name and other stored fields. **Use
> ids that cannot be guessed** (a random UUID, not a sequential number or an
> email address).

3. Register for push notifications:

```typescript
// background.js

// Anonymous subscriber:
pushTo
  .registerPushSubscription()
  .catch((error) => console.warn('Push registration failed', error));

// Or associate the subscriber with a user:
pushTo
  .registerPushSubscription({
    id: '7f9c2c1e-52b1-4f0e-9a51-0c1d6f3b8a44', // an id that cannot be guessed
    email: 'jane@example.com',
    name: 'Jane Doe'
  })
  .catch((error) => console.warn('Push registration failed', error));
```

A service worker script cannot use top-level `await`, so handle the promise
with `.then` / `.catch` (or call it inside an `async` function).

It is safe, and recommended, to call this on every service-worker start: the
SDK reuses the browser's existing push subscription and remembers what it last
sent, so when nothing changed it makes no request at all, except once every
24 hours (see [Registration](#registration)).

## API Reference

### PushNotifications

#### Constructor Options

```typescript
interface PushSubscriptionOptions {
  apiKey: string; // Required: a Push To API key with no permissions
  defaultNotificationIcon?: string; // Optional: icon for every notification
  apiBaseUrl?: string; // Optional: API host, without /v1
  vapidPublicKey?: string; // Optional: the platform's VAPID public key
}
```

| Option | Description |
| --- | --- |
| `apiKey` | A Push To API key. Use one **without** the `sending` / `admin` permission (see above). |
| `defaultNotificationIcon` | Icon used for every notification. Wins over the notification's own `data.icon`. |
| `apiBaseUrl` | Host of the Push To API, **without** `/v1` (the SDK appends it; a trailing slash is fine). Overrides the host the package was built with. Must be `https:` (`http:` is accepted for `localhost` / `127.0.0.1` only, because the key travels in a header) and have no query or fragment. An invalid value throws from the constructor. |
| `vapidPublicKey` | The platform's VAPID public key (base64url). When omitted, the SDK reads it from `GET /v1/vapid-key` and keeps it in `chrome.storage.local` for up to 24 hours. |

#### Methods

- `registerPushSubscription(user?: User): Promise<void>`
  - Registers the push subscription with Push To. Pass an optional `User` to
    associate the subscriber with an identity; omit it for an anonymous
    subscriber. Rejects with a [`PushToApiError`](#errors) when the API refuses
    the call.

```typescript
interface User {
  id?: string;
  email?: string;
  name?: string;
  imageUrl?: string;
  language?: string;
}
```

### Registration

`registerPushSubscription` makes two calls: `POST /v1/users`, then
`POST /v1/users/{id}/endpoints` with the browser's push subscription.

**How `User` maps to the API**

| `User` field | Sent as |
| --- | --- |
| `id` | user `external_id` (use a value that cannot be guessed, see the note on keys above). Without an `id` the SDK sends `anon:<anonymousId>` (an id it generates once and keeps in `chrome.storage.local`), so registering again updates the same user instead of creating a new one. |
| `email` | user `email`. Must be a valid address, or the API answers `422`. |
| `name` | split on the first run of whitespace into user `first_name` and `last_name` (`"Jane van der Berg"` → `Jane` / `van der Berg`; a single word is only a `first_name`). |
| `imageUrl` | endpoint `metadata.image_url` |
| `language` | endpoint `metadata.language` |

Absent and empty fields are left out. The SDK never sends the user's
`properties` or `preferences`: set those from your server.

The endpoint is registered with this `metadata`: `channel` (`"extension"`),
`extension_id`, `browser_language`, `context_url`, `sdk_version`,
`anonymous_id`, and `image_url` / `language` when given.

**What is skipped.** The SDK first asks the browser for its existing push
subscription and reuses it; it only subscribes again when there is none, or
when the existing one was made for a different VAPID key (that one is
unsubscribed first). After a successful registration it stores, in
`chrome.storage.local`, the time and a hash of everything it sent (API host,
key, user fields, endpoint, subscription keys, metadata). While that hash is
unchanged and the registration is less than 24 hours old,
`registerPushSubscription` makes no request.

After 24 hours both calls are sent again even if nothing changed, and the
VAPID key is read again. That is how a device recovers from what it cannot
see: a subscription the API disabled, a user removed on the server, a rotated
VAPID key. Any full registration reads the VAPID key again as well.

### Notifications

The SDK shows the push message the Push To API sends:

```json
{ "title": "Goal!", "body": "Arsenal 1-0", "data": { "url": "https://example.com/match/1" }, "notification_id": 1234 }
```

`title` and `body` are the notification's title and message (`body` may be
`null`). `data` is whatever you set when sending; the SDK reads these members
from it. All are optional, and a member of the wrong type is ignored:

| `data` member | Type | Effect |
| --- | --- | --- |
| `url` | string | Opened in a new tab when the notification is clicked. Only an absolute `http:` or `https:` URL is opened; anything else (`javascript:`, `chrome:`, a relative URL…) opens nothing. |
| `icon` | string (`https:` URL) | The notification icon. |
| `context_message` | string | Secondary line of the notification (`contextMessage`). |
| `badge` | `{ "text": string, "color"?: string }` | Sets the toolbar badge when the notification is shown; cleared when it is clicked, or when the toolbar icon is clicked. |
| `tag` | string | A new notification removes the ones still on screen with the same tag. |
| `auto_dismiss` | `{ "behavior": "timed", "dismiss_time_ms": number }` | Removes the notification after that long, even if the service worker was terminated in between. Chrome cannot fire a timer under 30 s for a terminated worker, so a shorter time is exact while the worker stays alive and about 30 s otherwise. |

**Icon.** The first of these that exists is used: the constructor's
`defaultNotificationIcon`, `data.icon`, the largest icon in your manifest's
`icons`, then a built-in transparent image. If Chrome cannot load an icon the
next one is tried, so the notification is still shown. Whether Chrome loads
a remote icon for an extension that has no `host_permissions` for the icon's
host has not been verified; if it does not, the fallback applies, and adding
the host to `host_permissions` (or using `defaultNotificationIcon` with a
packaged image) is the way to get your icon.

A push message in any other shape is logged with `console.warn` and ignored.

#### Events sent

The SDK reports what happens to each notification with `POST /v1/feedback`
(`{ notification_id, event_type }`; the API stamps the time, so a device with
a wrong clock still reports correctly):

| When | `event_type` |
| --- | --- |
| The notification is shown | `delivered` |
| The user clicks it | `clicked` |
| The tab for `data.url` has opened | `opened` |
| The user closes it | `dismissed` |
| The system closes it, it is auto-dismissed, or it is replaced by one with the same `tag` | nothing |

`dismissed` is sent only when Chrome reports the close as made by the user
(`byUser` in `chrome.notifications.onClosed`). What Chrome reports for each
way of closing a notification on each platform (for example from the macOS or
Windows notification centre) still has to be confirmed in real Chrome; where
it reports `false`, no `dismissed` is sent.

Feedback is best effort: a failed call is logged with `console.warn` and never
throws or interrupts showing the notification or opening its URL. If
`chrome.storage.local` cannot be written, the notification is still shown, but
its click opens nothing and reports nothing.

### Errors

A refused API call rejects with a `PushToApiError`:

```typescript
import { PushNotifications, PushToApiError } from '@push-to/chrome-extension';

try {
  await pushTo.registerPushSubscription({ id: 'user-123', email: 'not-an-email' });
} catch (error) {
  if (error instanceof PushToApiError) {
    error.status; // 422
    error.code; // "validation_error"
    error.message; // "email must be an email address"
    error.details; // extra context, when the API gives any
  }
}
```

`status` and `code` come from the API (`401 unauthorized`,
`422 validation_error`, `422 endpoint_limit_reached` when a user already has 20
active subscriptions, …). Two codes are the SDK's own: `network_error` (the
request got no response within 10 seconds; `status` is `0`) and `http_error` (a response without
the API's error body). A network error and a `503` are retried twice, with a
short backoff, before the call fails.

## Migrating from 0.0.x

Version 0.0.x talked to the previous Push To backend. This version talks to the
Push To API (`/v1`), and that changes a few things:

- **API key.** Create a Push To API key with no permissions and use it as
  `apiKey`. Keys of the previous backend do not work.
- **Users must register again.** Subscriptions held by the previous backend are
  not carried over. Nothing to do if you already call
  `registerPushSubscription()` on every service-worker start: the first run
  after the update registers the browser with the new API (subscribing again
  if the platform's VAPID key is not the one the old subscription was made
  for). `registerPushSubscription(user?)` itself is unchanged.
- **`User` fields are stored differently.** See
  [Registration](#registration): `name` becomes `first_name` / `last_name`,
  and `imageUrl` / `language` are stored on the subscription, not on the user.
- **Sending.** Notifications are sent with `POST /v1/notifications`
  (`{ user_id, title, body, data }`) and the display options move into `data`:
  `link` → `data.url`, `icon` → `data.icon`, `contextMessage` →
  `data.context_message`, `autoDismissOptions: { behavior: "timed", dismissTimeMS }`
  → `data.auto_dismiss: { behavior: "timed", dismiss_time_ms }`; `badge` and
  `tag` keep their names, inside `data`.
- **Click targets must be `http:` or `https:`.** A link to one of your
  extension's own pages (`chrome-extension://…`), which the previous `link`
  allowed, no longer opens. This applies to legacy notifications too.
- **`dismissed` is narrower than `closed` was.** It is sent only for a close
  made by the user; the previous version reported every close.
- **Legacy notifications are shown but not tracked.** While the previous
  backend still pushes to old subscriptions, the SDK keeps displaying its
  messages (title, body, icon, link, badge, tag, auto-dismiss), and sends no
  event for them.
- **Tracking.** `POST /notifications/track` is replaced by `POST /v1/feedback`
  with the events [listed above](#events-sent). There is no `auto-dismissed`
  event any more.
- **`host_permissions`** for the API host are optional.

## Browser Support

| <img src="https://raw.githubusercontent.com/alrra/browser-logos/main/src/chrome/chrome.svg" width="48px" height="48px" alt="Chrome logo"> | 
|:---:|
| Chrome ✔ |

## Development

1. Clone the repository:
```bash
git clone https://github.com/yourusername/push-to-chrome-extension.git
```

2. Install dependencies:
```bash
pnpm install
```

3. Build the package. The build needs `PUSHTO_CORE_URL`, the default host of
the Push To API **without** `/v1` (see `packages/chrome-extension/.env.example`):
```bash
PUSHTO_CORE_URL=https://your-push-api-host bun run build
```

Run the tests (mocked `chrome.*` and a fake API; no network):
```bash
bun test
```

4. For local testing:
```bash
pnpm dev
```

## Contributing

Contributions are welcome! Please read our contributing guidelines before submitting a pull request.

### Release Process

This project uses **automated releases** powered by [semantic-release](https://github.com/semantic-release/semantic-release). When code is merged to the `main` branch, the release process automatically:

1. Analyzes commit messages to determine the version bump
2. Updates the package version
3. Generates a changelog
4. Creates a git tag
5. Publishes to NPM
6. Creates a GitHub release

#### Commit Message Format

To trigger releases, use [Conventional Commits](https://www.conventionalcommits.org/) format:

```
<type>(<scope>): <subject>

<body>

<footer>
```

**Types and their effects:**
- `feat:` - New feature (triggers **minor** version bump, e.g., 1.0.0 → 1.1.0)
- `fix:` - Bug fix (triggers **patch** version bump, e.g., 1.0.0 → 1.0.1)
- `perf:` - Performance improvement (triggers **patch** version bump)
- `docs:` - Documentation changes (triggers **patch** version bump)
- `refactor:` - Code refactoring (triggers **patch** version bump)
- `chore:` - Maintenance tasks (no release)
- `test:` - Test changes (no release)
- `ci:` - CI/CD changes (no release)

**Breaking changes:**
Add `BREAKING CHANGE:` in the commit footer to trigger a **major** version bump (e.g., 1.0.0 → 2.0.0):

```
feat: redesign notification API

BREAKING CHANGE: The notification options interface has changed.
Old code using `notificationIcon` must be updated to `defaultNotificationIcon`.
```

**Examples:**
```bash
# Patch release (1.0.0 → 1.0.1)
git commit -m "fix: resolve subscription registration error"

# Minor release (1.0.0 → 1.1.0)
git commit -m "feat: add support for notification actions"

# Major release (1.0.0 → 2.0.0)
git commit -m "feat!: redesign core API

BREAKING CHANGE: Complete API redesign for better type safety"
```

## License

MIT License