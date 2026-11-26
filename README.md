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
> What such a key **can** do, and nothing else: read the VAPID public key,
> report feedback, and register a push subscription for a user named by its
> `external_id` (the `id` you pass to `registerPushSubscription`). That call
> creates the user if it does not exist; it never changes or returns an
> existing user's email, name or other stored fields, and it cannot address a
> user by its numeric Push To id.
>
> It does mean that anyone holding the key who knows or can guess a user's
> `id` can register their own browser for that user and receive that user's
> notifications. Turn on [identity verification](#identity-verification) to
> close that. Until you do, **use ids that cannot be guessed** (a random UUID,
> not a sequential number or an email address).

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
    name: 'Jane Doe',
    // Optional: the proof your server computed for this id, see
    // "Identity verification".
    hash: userHashFromYourServer
  })
  .catch((error) => console.warn('Push registration failed', error));
```

Pass the same `User` on every call. Calling `registerPushSubscription()`
without one after a user was registered means **logout**: the browser's
subscription moves back to the anonymous user and stops receiving the
identified user's notifications.

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
| `apiBaseUrl` | Host of the Push To API, **without** `/v1` (the SDK appends it; a trailing slash is fine). Overrides the host the package was built with. Must be `https:` (`http:` is accepted for loopback hosts only: `localhost`, `*.localhost`, `127.0.0.1`, `[::1]`, because the key travels in a header) and have no query or fragment. An invalid value throws from the constructor. |
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
  hash?: string; // identity proof for `id`, computed by your server
  email?: string;
  name?: string;
  imageUrl?: string;
  language?: string;
}
```

### Registration

`registerPushSubscription` makes one call, `POST /v1/subscriptions`, with the
user's `external_id` and the browser's push subscription
(`PushSubscription.toJSON()`). The API finds the
user with that `external_id`, or creates it, and registers the subscription
for it, all or nothing.

`email` and `name` are stored **only when the call creates the user**. An
existing user is never changed from the extension: update it from your server
(`POST /v1/users` with a sending key).

A subscription belongs to one user at a time. Registering it for another user
(login, logout) moves it: the previous user stops receiving on this browser.

**How `User` maps to the API**

| `User` field | Sent as |
| --- | --- |
| `id` | `external_id`, with surrounding whitespace trimmed (use a value that cannot be guessed, or turn on [identity verification](#identity-verification)). Without an `id` the SDK sends `anon:<anonymousId>` (a random UUID it generates once and keeps in `chrome.storage.local`), so registering again reaches the same user instead of creating a new one. |
| `hash` | `user_hash`, only when an `id` is given. Never sent for an anonymous subscriber: a `hash` without an `id` is dropped, with one `console.warn`. See [Identity verification](#identity-verification). |
| `email` | user `email`. Must be a valid address, or the API answers `422`. |
| `name` | split on the first run of whitespace into user `first_name` and `last_name` (`"Jane van der Berg"` → `Jane` / `van der Berg`; a single word is only a `first_name`). |
| `imageUrl` | subscription `metadata.image_url` |
| `language` | subscription `metadata.language` |

Absent and empty fields are left out. The SDK never sends the user's
`properties` or `preferences`: set those from your server.

The subscription is registered with this `metadata`: `channel` (`"extension"`),
`extension_id`, `browser_language`, `context_url`, `sdk_version`,
`anonymous_id`, and `image_url` / `language` when given.

**What is skipped.** The SDK first asks the browser for its existing push
subscription and reuses it; it only subscribes again when there is none, or
when the existing one was made for a different VAPID key (that one is
unsubscribed first). After a successful registration it stores, in
`chrome.storage.local`, the time and a hash of everything it sent (API host,
key, user fields, `hash`, endpoint, subscription keys, metadata). While that
hash is unchanged and the registration is less than 24 hours old,
`registerPushSubscription` makes no request. Only that one-way hash is kept:
the SDK does not store `User.hash`, so pass it on every call.

After 24 hours the call is sent again even if nothing changed. When
`vapidPublicKey` is not configured, the VAPID key is read again then, and on
any other full registration as well; a configured key is used as it is. That
is how a device recovers from what it cannot see: a subscription the API
disabled, a user removed on the server, a rotated VAPID key (a configured key
that was rotated has to be changed in your code).

**A subscription the API refuses.** If the API answers
`409 endpoint_conflict` (the browser's push address is already registered
with different keys, to this user or to another one, which this browser's own
registrations cannot cause), the SDK unsubscribes, subscribes again and registers the new
subscription, once. A second refusal rejects the promise.

### Identity verification

Without it, the `id` alone decides which user a browser subscribes to: whoever
knows a user's id (and your public key) can receive that user's
notifications. With identity verification, your **server** vouches for the id
with a proof the extension cannot compute:

```
user_hash = lowercase_hex( HMAC-SHA256( key = identity_secret, message = id ) )
```

1. **Issue the identity secret**, from your server, with a key that has the
   `sending` (or `admin`) permission:

   ```sh
   curl -X POST "$PUSH_API_URL/v1/identity-verification/secret" \
     -H "Authorization: Bearer $PUSHTO_SENDING_KEY"
   # 201 { "secret": "pt_idsec_…", "generation": 1, "previous_generation_valid_until": null }
   ```

   The secret is shown **only in this response**; it cannot be read again.
   Store it as a server-side secret. It must never ship in the extension.
2. **Compute the hash on your server** whenever it tells the extension who the
   user is, and send it along with the id:

   ```js
   // Node
   crypto.createHmac('sha256', secret).update(id).digest('hex');
   ```
   ```python
   # Python
   hmac.new(secret.encode(), id.encode(), hashlib.sha256).hexdigest()
   ```
   ```php
   // PHP
   hash_hmac('sha256', $id, $secret);
   ```
   ```ruby
   # Ruby
   OpenSSL::HMAC.hexdigest('SHA256', secret, id)
   ```

   To check your implementation: secret `example-secret` and id `user-123`
   give `71a48035b503170a70367c1c0ee323ea2477df3d0f43241ff3451f463b87551e`.
3. **Pass both to the SDK**, on every call:
   `registerPushSubscription({ id, hash })`. Enforcement is still off, but a
   hash that is sent is always checked, so a mistake shows up now as
   `403 invalid_user_hash`, while users without a hash still register.
4. **Switch enforcement on** once every client sends a hash:

   ```sh
   curl -X PATCH "$PUSH_API_URL/v1/identity-verification" \
     -H "Authorization: Bearer $PUSHTO_SENDING_KEY" \
     -H "Content-Type: application/json" \
     -d '{ "required": true }'
   ```

   `GET /v1/identity-verification` shows the current state, and
   `{ "required": false }` switches it off again.

Things to know:

- **Hash exactly the string the SDK sends as `external_id`.** The API checks
  the hash against that string byte for byte: no lower-casing, no
  normalisation. The only thing the SDK does to a string `id` is remove
  surrounding whitespace (JavaScript's `String.prototype.trim`); it never
  changes case or anything inside the id. A numeric `id` is sent as its
  decimal string (`42` → `"42"`). So `" user-1"` is sent, and must be hashed,
  as `"user-1"`, while `"User-1"` and `"user-1"` are two different ids with
  two different hashes. The safe rule: give the SDK and your hash function
  the same id, with no surrounding whitespace.
- **Enforcement is opt-in per tenant**, and off by default. While it is off, a
  registration without a hash is accepted.
- With enforcement on, an identified `id` without a hash is refused
  (`403 user_hash_required`). Anonymous subscribers (no `id`) need no hash:
  their random `anon:<uuid>` id is itself the secret.
- **`anon:` is reserved** for ids the SDK generates. An id of exactly the
  shape `anon:<lowercase uuid>` needs no proof, so never give one to an
  identified user. Any other id starting with `anon:` needs its hash like any
  identified id.
- The hash is 64 hex digits and does not expire. To revoke hashes, rotate the
  secret by calling `POST /v1/identity-verification/secret` again: the
  previous secret stays valid for 24 hours by default
  (`{ "previous_valid_for_seconds": 0 }` revokes it at once; the maximum is
  7 days). The SDK sends the new hash as soon as you pass it (a changed
  `hash` registers again).
- A `403` is not retried and not remembered: the next
  `registerPushSubscription` call tries again.
- `503 identity_verification_unavailable` means the API deployment itself
  cannot check hashes (it has no signing key). It is not retried either;
  only the API's operator can fix it.

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

`status` and `code` come from the API:

| Status | `code` | When |
| --- | --- | --- |
| `401` | `unauthorized` | Missing or invalid API key. |
| `403` | `user_hash_required` | Identity verification is on and an `id` was sent without `hash`. |
| `403` | `invalid_user_hash` | The `hash` is not the one for this `id` (or no identity secret was issued). |
| `409` | `endpoint_conflict` | The subscription's address is registered with different keys, and still was after the SDK replaced it once. |
| `422` | `validation_error` | A field was refused, for example an invalid `email`. |
| `422` | `endpoint_limit_reached` | The user already has 20 active subscriptions. |
| `503` | `identity_verification_unavailable` | The API deployment cannot check hashes at all. Not retried. |

Two codes are the SDK's own: `network_error` (the request failed, or got no
response within 10 seconds; `status` is `0`) and `http_error` (a response without
the API's error body). The 10-second timeout applies where `AbortSignal.timeout`
exists (Chrome 103+); on an older Chrome only a failed request is a
`network_error`. A network error and a `503` are retried twice, with a
short backoff, before the call fails; nothing else is retried, and neither is
`503 identity_verification_unavailable`, which trying again cannot fix. A failed
registration is not remembered, so the next call sends it again.

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
- **Registration is one call**, `POST /v1/subscriptions`. A key without
  permissions cannot call `POST /v1/users` or
  `POST /v1/users/{id}/endpoints`: those are for your server.
- **`User` fields are stored differently.** See
  [Registration](#registration): `name` becomes `first_name` / `last_name`,
  and `imageUrl` / `language` are stored on the subscription, not on the user.
- **`email` and `name` no longer update an existing user.** They are stored
  when the registration creates the user; after that, change them from your
  server.
- **`User.hash` is new and optional.** It is only needed if you turn on
  [identity verification](#identity-verification).
- **Registering without a `User` after a login is a logout**: the
  subscription moves back to the anonymous user.
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