# @push-to/chrome-extension

Push notifications for Chrome extensions (Manifest V3) through the Push To
API. The SDK runs in your extension's background service worker: it
subscribes the browser, registers it for a user, displays the notifications
you send and reports what the user did with them.

Contents:
[Quick start](#quick-start) ·
[Identity](#identity) ·
[Identity verification](#identity-verification) ·
[Lifecycle and deletion](#lifecycle-and-deletion) ·
[Verify your integration](#verify-your-integration) ·
[What the SDK sends](#what-the-sdk-sends) ·
[What the SDK owns in your extension](#what-the-sdk-owns-in-your-extension) ·
[`userVisibleOnly`](#uservisibleonly) ·
[API reference](#api-reference) ·
[Migrating](#migrating) ·
[Development](#development)

## Install

```sh
npm install @push-to/chrome-extension
```

The package has no runtime dependencies. Its type declarations do not need
`@types/chrome`.

## Quick start

You need two Push To API keys of the same tenant:

- a **browser key**: a key with **no permissions**. It ships inside your
  extension, so treat it as public. All it can do is read the VAPID public
  key, register / remove / test this browser's own subscription and report
  feedback.
- a **sending key** (permission `sending`): stays on your server. It sends
  notifications and manages users.

Which path you take depends on one thing: does your extension already have
users?

- [New extension](#path-a-a-new-extension): declare `notifications` as a
  normal permission.
- [Extension with existing users](#path-b-an-extension-that-already-has-users):
  declare it as an **optional** permission and ask for it from a button.
  Chrome shows the warning "Display notifications" for this permission, and
  when an update adds a permission with a warning, the extension is disabled
  for everyone who already installed it until they accept the new permission
  ([permission warnings](https://developer.chrome.com/docs/extensions/develop/concepts/permission-warnings),
  [Web Push in extensions](https://developer.chrome.com/docs/extensions/how-to/integrate/web-push)).
  An optional permission avoids that.

### Path A: a new extension

**1. Manifest**

```json
{
  "manifest_version": 3,
  "background": { "service_worker": "background.js" },
  "permissions": ["notifications", "alarms", "storage"],
  "action": {}
}
```

- `"type": "module"` (inside `"background"`) is what lets the service worker
  file use the `import` statement. Add it when `background.js` itself
  contains `import`; a bundler that emits one file without `import`
  statements does not need it.
- No `host_permissions` are needed: the API answers cross-origin requests
  (CORS) on every route the SDK calls.
- `"action": {}` is optional. With it the SDK can set and clear the toolbar
  badge (a notification's `data.badge`); without it badges are skipped.
- `chrome.tabs.create`, which opens a notification's link, does not need the
  `tabs` permission.

**2. Service worker**

The snippets in this guide import the package by name
(`'@push-to/chrome-extension'`), which needs a bundler (esbuild, Vite,
webpack, Rollup, …): Chrome cannot resolve a package name in an extension's
service worker or page.

Without a bundler, copy two files from the package into your extension and
import them by relative path:

- `node_modules/@push-to/chrome-extension/dist/index.js` for the service
  worker: `import { PushNotifications } from './vendor/pushto.js';`, with
  `"type": "module"` in the manifest's `"background"`;
- `node_modules/@push-to/chrome-extension/dist/page.js` for a page:
  `import { requestNotificationPermission } from './vendor/pushto-page.js';`
  in a `<script type="module">`.

Each of the two is one self-contained file.

```js
// background.js
import { PushNotifications } from '@push-to/chrome-extension';

// At the top level of the file, not inside a callback.
const pushTo = new PushNotifications({
  apiKey: 'your-browser-key',
});

// On every service-worker start. Signed in: identify. Signed out: reset.
async function syncPushIdentity() {
  const user = await getSignedInUser(); // your code
  const result = user
    ? await pushTo.identify({ id: user.id, hash: user.pushToHash })
    : await pushTo.reset();
  console.log('push registration', result);
}
syncPushIdentity().catch((error) => console.warn('push registration failed', error));
```

`new PushNotifications(...)` **must run synchronously at the top level of the
service worker**, not inside `chrome.runtime.onInstalled` or another
callback: Chrome starts a terminated worker to deliver a push, an alarm or a
notification click, and only listeners that were added while the worker
script first ran receive that event. The constructor adds the listeners and
makes no request.

A service worker script cannot use top-level `await`, so handle the promises
with `.then` / `.catch` or inside an `async` function.

Calling `identify` / `reset` on every start is cheap: when nothing changed in
the last 24 hours it makes no request and resolves with
`status: 'unchanged'`. It is also safe after the user turned notifications
off with `unsubscribe()`: the call registers nothing then and resolves with
`status: 'unsubscribed'`. Only `subscribe()` turns them back on.

**3. Sign-in and sign-out.** Call `pushTo.identify({ id, hash })` when the
user signs in and `pushTo.reset()` when they sign out. See
[Identity](#identity).

**4. Check it.** See [Verify your integration](#verify-your-integration).

### Path B: an extension that already has users

**1. Manifest**: `notifications` goes in `optional_permissions`.

```json
{
  "manifest_version": 3,
  "background": { "service_worker": "background.js" },
  "permissions": ["alarms", "storage"],
  "optional_permissions": ["notifications"],
  "action": { "default_popup": "popup.html" }
}
```

The notes of Path A apply. Check the other permissions your update adds
against Chrome's
[list of permission warnings](https://developer.chrome.com/docs/extensions/reference/permissions-list)
in the same way.

**2. Service worker**: exactly the code of Path A. Nothing has to be guarded:

- The constructor never throws because the permission is missing. It adds
  every listener it can and leaves out the `chrome.notifications` ones.
- `identify` / `reset` resolve with `status: 'permission_required'` instead
  of rejecting. Nothing is subscribed and nothing is sent, and the SDK
  remembers the identity you asked for.
- When the permission is granted, the SDK in the service worker adds its
  notification listeners and registers with the remembered identity. It
  learns of the grant in two ways, and you write neither:
  `chrome.permissions.onAdded`, and a message that
  `requestNotificationPermission()` sends from your page after the grant.
  Chrome does not document whether `permissions.onAdded` is delivered to a
  service worker, and we have not yet confirmed it on a real device; the
  message is there so that the flow does not depend on it.

**3. A button in one of your pages** (popup, options page, side panel):

```js
// popup.js
import { requestNotificationPermission } from '@push-to/chrome-extension/page';

document.querySelector('#enable-notifications').addEventListener('click', async () => {
  // First thing in the click handler, with no `await` before it.
  const granted = await requestNotificationPermission();
  showNotificationsEnabled(granted); // your code
});
```

`requestNotificationPermission()` calls
`chrome.permissions.request({ permissions: ['notifications'] })` and resolves
to whether the user accepted. Chrome only accepts a permission request made
inside a user gesture, such as a click handler; an `await` on something else
before it can lose the gesture, which is why it must be the first call.
After a grant it sends your service worker one message,
`{ type: 'pushto:permission-granted' }`, which the SDK there handles (your own
`chrome.runtime.onMessage` listeners see it too and can ignore it). The
`/page` entry contains this function and nothing else, so it is safe in a
page: no service-worker code is loaded.

**4. Keep calling `identify` / `reset` on every service-worker start**, as in
the code above. It is the last safety net for what is not yet confirmed on a
real Chrome:

- whether `permissions.onAdded` reaches the service worker (covered by the
  message above);
- whether a service worker that is already running gets
  `chrome.notifications` and a working `pushManager` the moment the
  permission is granted, or only after it restarts. The SDK attaches its
  notification listeners wherever the API first appears; if the registration
  made on the grant fails, it is logged and the call on the next worker
  start makes it.

After a browser restart there is one more case in which that call is what
registers: an identity given with a `hash` (or `email`, `name`, …) that was
still waiting for the permission. Those fields are kept for the browser
session only (see [storage](#what-the-sdk-owns-in-your-extension)), so the
SDK waits for your `identify` instead of registering without them.

**5. Check it.** `getState()` shows each step:

| Moment | `permission` | `subscribed` | `registered` |
| --- | --- | --- | --- |
| Before the user clicks the button | `missing` | `false` | `false` |
| After the grant, once the registration finished | `granted` | `true` | `true` |

If the second row does not show up within a few seconds of the grant, reload
the extension once and look again: then the registration was made by the
startup call, and we would like to hear about it (with your Chrome version).

## Identity

```ts
pushTo.identify(user: User): Promise<RegistrationResult>
pushTo.reset(): Promise<RegistrationResult>
```

**`identify({ id, hash?, email?, name?, imageUrl?, language? })`** — call it
when the user signs in, and on every service-worker start while they are
signed in. `id` is your own id for the user and is required (a `TypeError`
without one). A numeric `id` must be a safe integer; pass a larger one as a
string (see [Things to know](#things-to-know)). On the server:

- The user with `external_id` = `id` is found, or created if it does not
  exist. `email` and `name` are stored **only when the call creates the
  user**; an existing user is never changed from the extension (update it
  from your server with `POST /v1/users` and the sending key).
- This browser's push subscription becomes an active endpoint of that user.
- The same subscription is **disabled for every other user of your tenant**,
  in the same transaction. A browser is active for one user at a time.

**`reset()`** — call it when the user signs out. On the server:

- The browser's push subscription is registered under the anonymous user of
  this browser, `anon:<anonymousId>` (a random UUID the SDK generates once
  and keeps in `chrome.storage.local`).
- By the rule above it is **disabled for the user who was signed in**: that
  user's notifications no longer reach this browser. Their other browsers
  are not affected.
- The previous user's row stays on the server, with this browser's endpoint
  disabled. Deleting the user is a server-side call: see
  [Lifecycle and deletion](#lifecycle-and-deletion).

In the browser, `reset()` also drops what the SDK remembered about the
previous user (`id`, `hash`, `email`, `name`, …). This is best effort: if
the browser's storage cannot be written, the failure is logged and the call
goes on.

**Shared computers.** When the signed-in user changes (`reset()` after
`identify`, or `identify` for a different id), the SDK also takes the
notifications it still has on screen away, with their stored state and
auto-dismiss alarms, and clears the toolbar badge if it set it. This happens
at once, before the request and whether or not the request succeeds, and no
`dismissed` is reported for them. Notifications your extension created itself
are not touched. Calling `reset()` or `identify` again for the same user (as
on every service-worker start) clears nothing, and neither does signing in
from the anonymous subscriber.

Delivery is a separate matter, and this is exactly what holds:

- **Until the API has confirmed the change** (`reset()` or the new
  `identify` resolved with `registered` or `unchanged`), the server still has
  the browser registered for the previous user. During that time the SDK
  displays **nothing** that arrives and reports nothing for it: a sign-out
  made offline does not leave the previous user's notifications appearing
  for the next person. So call `reset()` as part of your sign-out and, if it
  rejects (offline), call it again on the next service-worker start; until
  it succeeds this browser shows no notifications at all. When it does
  succeed, the screen is cleared once more.
- **Until the first registration has succeeded** the same holds. Once you
  have called `identify` / `reset`, nothing that arrives is displayed until
  a registration for that identity has succeeded: while the call resolves
  with `permission_required`, while a first `identify` keeps being refused,
  and between `subscribe()` and its registration after an `unsubscribe()`.
  Nothing the API sends to that identity can arrive before its registration
  exists; what is held back was addressed to whoever this browser was
  registered for before. A browser updated from 1.0 is the exception: the
  registration 1.0 cached does not say whom it was for, so nothing is held
  back until the first registration made by this version.
- **What can still be displayed:** a notification the API sent to the
  previous user *before* it confirmed the change, which the push service
  delivers to this browser only afterwards (the device was asleep or
  offline; a notification is kept by the push service for up to its TTL, 24
  hours by default). The SDK cannot tell such a message from one for the new
  user, so it is shown. If that matters for your content, send with a short
  `ttl`.
- A browser that was signed out is not otherwise special: notifications sent
  to the previous user after the change go to their other browsers only.

**The result**

```ts
interface RegistrationResult {
  status: 'registered' | 'unchanged' | 'permission_required' | 'unsubscribed';
  userId?: number;     // Push To's id of the user
  endpointId?: number; // Push To's id of this browser's endpoint
  externalId: string;  // your id, or `anon:<anonymousId>`
}
```

| `status` | Meaning |
| --- | --- |
| `registered` | The API was called and accepted the registration. |
| `unchanged` | Nothing changed since a registration under 24 hours old: no request was made. The ids are the ones of that registration. |
| `permission_required` | The extension does not hold the `notifications` permission. Nothing was sent; `userId` and `endpointId` are absent. The SDK registers by itself when the permission is granted, with one exception: an identity given with more than an `id` (`hash`, `email`, …) after the browser has restarted is registered by your `identify` at startup instead (see [Path B](#path-b-an-extension-that-already-has-users), step 4). |
| `unsubscribed` | `unsubscribe()` was called and `subscribe()` not since. Nothing was subscribed or sent; `userId` and `endpointId` are absent. The identity is remembered, and `subscribe()` registers it. |

`userId` is the `user_id` you pass to `POST /v1/notifications` to send to
this user.

`registerPushSubscription(user?)` is the older name for the same call and
keeps working: with a `user` that has an `id` it is `identify(user)`, without
a `user` it is `reset()`. It now resolves to the same `RegistrationResult`.
Prefer `identify` and `reset`.

**`subscribe()`** registers with the identity last given to `identify` /
`reset` (the anonymous subscriber if none was). It is the one call that turns
notifications back on after `unsubscribe()`; see
[Lifecycle and deletion](#lifecycle-and-deletion).

## Identity verification

By default the `id` alone decides which user a browser registers for.
Whoever has your browser key (it is in your extension) and knows a user's id
can register their own browser for that user and receive that user's
notifications.

**If the id is visible anywhere outside your own server and the signed-in
user themselves (a URL, a chat row, a public profile, another user's client,
an API response other users can read), turn identity verification on and
pass `hash`. A random UUID is not a secret: it only cannot be guessed, and an
id that other people can see does not need guessing.**

With verification on, your server vouches for the id with a proof the
extension cannot compute:

```
hash = lowercase_hex( HMAC-SHA256( key = identity_secret, message = id ) )
```

- `key` is the whole identity secret as issued, prefix included
  (`pt_idsec_…`), as UTF-8 bytes. Do not base64-decode it.
- `message` is the id as the SDK sends it, as UTF-8 (see *Hash exactly the
  string the SDK sends* below). The API compares byte for byte, with no
  trimming or case folding of its own.

### 1. Issue the identity secret

From your server or your terminal, with the **sending key** (here in the
environment variable `PUSHTO_SENDING_KEY`; `PUSH_API_URL` is the API host):

```sh
curl -X POST "$PUSH_API_URL/v1/identity-verification/secret" \
  -H "Authorization: Bearer $PUSHTO_SENDING_KEY"
# 201 { "secret": "pt_idsec_…", "generation": 1, "previous_generation_valid_until": null }
```

The secret is shown **only in this response**. Store it as a server-side
secret (below: `PUSHTO_IDENTITY_SECRET`). It must never ship in the
extension: whoever holds it can make a valid hash for any id.

### 2. Compute the hash on your server

Return it to the extension together with the id, from an endpoint that knows
who is signed in.

**Node**

```js
import { createHmac } from 'node:crypto';

export function pushToHash(userId) {
  return createHmac('sha256', process.env.PUSHTO_IDENTITY_SECRET)
    .update(String(userId))
    .digest('hex');
}

// In a route that has already authenticated the request:
//   res.json({ id: user.id, hash: pushToHash(user.id) });
```

Take the user from your session, never from the request: an endpoint that
hashes an id the caller names hands out a proof for anyone.

**Supabase Edge Function** (Deno, Web Crypto). It reads the signed-in user
from the request's JWT, so a caller can only get the hash of their own id.

```ts
// supabase/functions/pushto-identity/index.ts
import { createClient } from 'npm:@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

async function pushToHash(secret: string, id: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = await crypto.subtle.sign('HMAC', key, encoder.encode(id));
  return Array.from(new Uint8Array(mac), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') {
    return new Response('ok', { headers: cors });
  }

  // The user is taken from the JWT the client sent, never from the body.
  const token = (request.headers.get('Authorization') ?? '').replace(/^Bearer /, '');
  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_ANON_KEY')!,
  );
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data.user) {
    return Response.json({ error: 'not signed in' }, { status: 401, headers: cors });
  }

  const id = data.user.id;
  const hash = await pushToHash(Deno.env.get('PUSHTO_IDENTITY_SECRET')!, id);
  return Response.json({ id, hash }, { headers: cors });
});
```

```sh
supabase secrets set PUSHTO_IDENTITY_SECRET=pt_idsec_…
supabase functions deploy pushto-identity
```

In the extension, with the signed-in Supabase client:

```js
const { data, error } = await supabase.functions.invoke('pushto-identity');
if (!error) {
  await pushTo.identify({ id: data.id, hash: data.hash });
}
```

Other languages:

```python
hmac.new(secret.encode(), user_id.encode(), hashlib.sha256).hexdigest()  # Python
```
```php
hash_hmac('sha256', $userId, $secret); // PHP
```
```ruby
OpenSSL::HMAC.hexdigest('SHA256', secret, user_id) # Ruby
```

To check your implementation: secret `example-secret` and id `user-123` give
`71a48035b503170a70367c1c0ee323ea2477df3d0f43241ff3451f463b87551e`.

### 3. Pass `hash` to the SDK

`pushTo.identify({ id, hash })`, on every call. Enforcement is still off at
this point, but a hash that is sent is always checked, so a mistake shows up
now as `403 invalid_user_hash`, while clients that send no hash yet still
register.

### 4. Turn enforcement on

Once every client sends a hash:

```sh
curl -X PATCH "$PUSH_API_URL/v1/identity-verification" \
  -H "Authorization: Bearer $PUSHTO_SENDING_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "required": true }'
```

`GET /v1/identity-verification` shows the current state, and
`{ "required": false }` turns it off again.

### Things to know

- **Hash exactly the string the SDK sends.** The only thing the SDK does to
  a string `id` is remove surrounding whitespace (`String.prototype.trim`);
  a numeric `id` is sent as its decimal string (`42` → `"42"`). `"User-1"`
  and `"user-1"` are two different ids with two different hashes. The safe
  rule: give the SDK and your hash function the same id, with no surrounding
  whitespace.
- **A numeric `id` must be a safe integer** (`Number.isSafeInteger`). With
  any other number (`2 ** 53` or more, a fraction, `NaN`, `Infinity`)
  `identify` and `registerPushSubscription` reject with a `TypeError`, and
  nothing is remembered or sent. Pass an id that can be larger than
  `Number.MAX_SAFE_INTEGER` (a 64-bit database id, a snowflake) as a
  string, taken as a string from your server's JSON: as a number JavaScript
  has already rounded it, so two users would be registered under one
  `external_id` and neither hash would match.
- **Enforcement is per tenant, and off by default.**
- With enforcement on, an `id` without a hash is refused
  (`403 user_hash_required`). `reset()` (the anonymous subscriber) needs no
  hash: its random `anon:<uuid>` id is known only to this browser and the
  API. `getState()` returns it to your code as `anonymousId`; treat it like a
  session token and do not publish it, because whoever knows it can register
  their own browser as that anonymous subscriber.
- **`anon:` is reserved** for ids the SDK generates. Never give an id of the
  shape `anon:<lowercase uuid>` to an identified user.
- **Rotation.** The hash does not expire. To revoke hashes, issue a new
  secret with `POST /v1/identity-verification/secret` again: the previous
  secret stays valid for 24 hours by default
  (`{ "previous_valid_for_seconds": 0 }` revokes it at once; the maximum is
  7 days). Pass the new hash to `identify` and the SDK registers again.
- A `403` is not retried and not remembered: the next `identify` call tries
  again.
- `503 identity_verification_unavailable` means the API deployment itself
  cannot check hashes. It is not retried; only the API's operator can fix
  it.
- **Where the SDK keeps the hash.** The last `hash` you passed (with
  `email`, `name`, `imageUrl`, `language`) is kept in
  `chrome.storage.session`, so that a registration waiting for the
  `notifications` permission can be made later in the same browser session.
  It is never written to `chrome.storage.local`: that area is readable by
  your extension's own content scripts by default and is stored on disk
  unencrypted, and the hash does not expire. Session storage is limited to
  the extension's trusted contexts by default (unless your extension itself
  widens it with `chrome.storage.session.setAccessLevel`) and is emptied when
  the browser closes; `reset()` empties it too. This is also why you pass `hash`
  on every `identify` call.

## Lifecycle and deletion

### Stop notifications for this browser: `unsubscribe()`

```ts
pushTo.unsubscribe(): Promise<void>
```

1. An opted-out flag is stored. From here on nothing registers, and a push
   that still arrives is not displayed or reported.
2. The notifications the SDK has on screen are taken away (silently, as on a
   sign-out) and its badge is cleared.
3. The browser's push subscription is removed
   (`PushSubscription.unsubscribe()`). This is what stops delivery: the push
   service refuses the address from then on. It does not wait for the
   network.
4. The API is told to disable the subscription (`DELETE /v1/subscriptions`,
   with the subscription as the browser serialised it before step 3:
   address, expiry and keys). Best effort: if the API cannot be reached the
   failure is logged with `console.warn`, and the API disables the endpoint
   by itself the first time the push service reports it gone; until then the
   server still lists it as active.
5. The SDK deletes its registration cache and its VAPID key cache.

After it resolves, this browser displays no more notifications, offline too.
The promise rejects only if the browser could not remove the subscription;
the flag of step 1 holds even then.

If the `notifications` permission was removed before the call, there is no
subscription the SDK can reach (Chrome fails every `pushManager` call
without the permission), so steps 3 and 4 do not happen and the promise
still resolves. The flag is then what counts: the SDK displays nothing until
`subscribe()` is called, also if the permission is granted again.

**The opt-out survives your startup code.** While opted out, `identify`,
`reset` and `registerPushSubscription` register nothing: they remember the
identity, make no request and resolve with `status: 'unsubscribed'`. So the
Quick start's call on every service-worker start does not turn
notifications back on, and neither does a permission grant.

### Turn notifications back on: `subscribe()`

```ts
pushTo.subscribe(): Promise<RegistrationResult>
```

The only call that ends an opt-out. It clears the flag and registers with the
identity last given to `identify` / `reset` (also one given while opted out),
or the anonymous subscriber if none was. Call it from your "turn
notifications on" control:

```js
// popup.js, Path B. On Path A the message to the worker is all you need.
button.addEventListener('click', async () => {
  const granted = await requestNotificationPermission(); // first, no await before it
  if (granted) {
    await chrome.runtime.sendMessage({ type: 'my-app:enable-notifications' });
  }
});

// background.js
chrome.runtime.onMessage.addListener((message, sender) => {
  // Only from this extension's own pages, never from a content script.
  const fromOwnPage = sender.id === chrome.runtime.id && !sender.tab;
  if (fromOwnPage && message?.type === 'my-app:enable-notifications') {
    pushTo.subscribe().catch((error) => console.warn(error));
  }
});
```

Check the sender as above. `subscribe()` is the only call that ends an
opt-out, and content scripts run inside web pages: a message handler that
accepted it from one would let a page that compromises your content script
turn notifications back on. (A popup or options page has no `sender.tab`; a
page of yours opened in a tab does, so compare `sender.url` with
`chrome.runtime.getURL('')` instead if you need that.)

`unsubscribe()` and `subscribe()` are per browser. The user row and the
user's other browsers are untouched.

### Delete a user (account deletion)

This is a server-side call with the **sending key**. The SDK has no method
for it on purpose: the browser key is public and must not be able to delete
anyone.

```sh
# 1. Find the user by your own id.
PUSHTO_USER_ID=$(curl -s -G "$PUSH_API_URL/v1/users" \
  --data-urlencode "external_id=$YOUR_USER_ID" \
  -H "Authorization: Bearer $PUSHTO_SENDING_KEY" | jq '.data[0].id')

# 2. Delete it. 204 on success, 404 user_not_found if there is no such user.
curl -X DELETE "$PUSH_API_URL/v1/users/$PUSHTO_USER_ID" \
  -H "Authorization: Bearer $PUSHTO_SENDING_KEY"
```

`DELETE /v1/users/{id}` removes the user row (external id, email, names,
properties, preferences), its endpoints (push addresses and keys), and the
notifications, feedback events and decision records about it. The `userId`
that `identify` resolves with is the same id, if your server stored it.

Deleting the user on the server does not touch the browser. If the user is
still signed in there, the SDK's next full registration (at the latest 24
hours after the previous one) would create the user again. So, as part of
account deletion, call `reset()` in the extension: it forgets the identity,
and the browser goes back to its anonymous subscriber. Also call
`unsubscribe()` if this browser should stop receiving notifications
altogether. `unsubscribe()` alone is not enough: it keeps the identity for a
later `subscribe()`.

## Verify your integration

Everything below can be run from the service worker's DevTools console
(`chrome://extensions` → your extension → **service worker**) if you expose
the instance while developing (`globalThis.pushTo = pushTo`).

**1. Look at the result of `identify` / `reset`.** `status: 'registered'`
with a `userId` and an `endpointId` means the API accepted the registration.

**2. `getState()`** reads the browser and `chrome.storage.local`; it makes no
request.

```js
await pushTo.getState();
// {
//   permission: 'granted',        // or 'missing'
//   subscribed: true,             // the browser has a push subscription
//   registered: true,             // registered with the API < 24 h ago
//   optedOut: false,              // true after unsubscribe(), until subscribe()
//   // deliveryBlocked: 'opted_out' | 'identity_change_pending' when pushes are not shown
//   userId: 42, endpointId: 7,    // only when registered
//   externalId: 'user-123',       // registered, or last asked for
//   anonymousId: '0b6c…',
//   registeredAt: '2026-11-26T12:00:00.000Z',
//   apiBaseUrl: 'https://…/v1',
//   sdkVersion: '1.1.0'
// }
```

`registered` is what this browser remembers, not a question to the server.

**3. `sendTestNotification()`** proves that a notification really displays in
this browser:

```js
await pushTo.sendTestNotification(); // { notificationId: 123 }
```

The API sends one fixed notification ("Test notification" / "Push
notifications are working in this browser.") to this browser's subscription
and to nothing else. It arrives as a normal push and is displayed, clicked
and reported like any other; the API does not count test notifications or
their feedback in your statistics. A resolved promise means the push service
accepted the message; seeing the notification is the proof.

It rejects with a [`PushToApiError`](#errors):

| `code` | Meaning |
| --- | --- |
| `subscription_not_found` | This browser is not registered (or the API disabled it). Call `identify` / `reset` first (`subscribe()` after an `unsubscribe()`) and wait for `registered`. With `status` `0` no request was made: the browser has no push subscription, or the extension does not hold the `notifications` permission (the message says which). |
| `rate_limited` (`429`) | Too many tests. `error.details.retry_after` is the number of seconds to wait, and `error.details.scope` says which limit was hit: `"address"` (one test per browser every 30 seconds) or `"tenant"` (a ceiling on test pushes for your whole tenant). |
| `subscription_gone` (`410`) | The push service no longer knows this subscription. Call `unsubscribe()` and then `subscribe()` to make a new one. |
| `push_failed` (`502`) | The push service did not accept the message; try again later. |

**4. Send a real notification** from your terminal, with the sending key and
the `userId` from step 1:

```sh
curl -i "$PUSH_API_URL/v1/notifications" \
  -H "Authorization: Bearer $PUSHTO_SENDING_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "user_id": 42,
    "title": "Hello",
    "body": "From my server",
    "data": { "url": "https://example.com" }
  }'
```

The answer lists one entry per active browser of the user, each with
`status: "sent"` or `"failed"`.

**Use a separate tenant for development.** The API has no test-mode key and
no sandbox: every key reads and writes its tenant's real data, and every
browser you register while developing is a real user row. Create a second
tenant with its own browser key and sending key for development and CI, and
keep the production keys out of development builds. To clean up records you
did create, delete them with the
[delete-user call](#delete-a-user-account-deletion); for an anonymous
subscriber the id to look up is `anon:<anonymousId>` (see `getState()`).

## What the SDK sends

Everything goes to one host, the Push To API (`apiBaseUrl`, or the host the
package was built with), over HTTPS, with the browser key in the
`Authorization` header. Like any HTTPS request, the API also sees the
browser's IP address, its `User-Agent` and the extension's origin
(`chrome-extension://<extension id>`). The SDK loads no remote code and
contacts no other host.

| Request | When | What is sent |
| --- | --- | --- |
| `GET /v1/vapid-key` | On a full registration, unless `vapidPublicKey` is configured | Nothing but the key. |
| `POST /v1/subscriptions` | `identify`, `reset`, `registerPushSubscription`, and the automatic registration after the permission grant, when something changed or the last one is over 24 hours old | See the list below. |
| `POST /v1/feedback` | A notification was shown, clicked, opened or closed by the user | `notification_id` and `event_type` (`delivered`, `clicked`, `opened`, `dismissed`). No timestamp and no content. |
| `DELETE /v1/subscriptions` | `unsubscribe()` | The push subscription as the browser serialises it: address, expiry, keys. |
| `POST /v1/subscriptions/test` | `sendTestNotification()` | The push subscription as the browser serialises it: address, expiry, keys. |

`POST /v1/subscriptions` carries:

- **The push subscription** the browser created for this extension: its
  address at the browser's push service (`endpoint`), its `expirationTime`,
  its public key (`p256dh`) and its authentication secret (`auth`). The API
  needs both to encrypt a notification for this browser, and treats them as
  the proof that a later request comes from the same browser.
- **The user id**: the `id` you passed (`external_id`), or
  `anon:<anonymousId>` for an anonymous subscriber.
- **`user_hash`**: the `hash` you passed, if any.
- **User fields you passed**: `email`, and `name` split into `first_name` /
  `last_name`. Nothing if you pass none.
- **Metadata about the installation**: `channel` (always `"extension"`),
  `extension_id` (`chrome.runtime.id`), `context_url` (the extension's own
  root URL, `chrome-extension://<id>/`), `browser_language`
  (`navigator.language`), `sdk_version`, `anonymous_id` (the random UUID
  generated by the SDK), and `image_url` / `language` if you passed
  `imageUrl` / `language`.

The SDK does not read or send browsing history, tab URLs, page content,
cookies, or anything else from the browser. It never sends user
`properties` or `preferences`: set those from your server.

## What the SDK owns in your extension

The SDK acts only on what it created: its own notifications, its own badge,
its own alarms and storage keys.

**Listeners**, added once per worker by the constructor:

| Listener | What it does |
| --- | --- |
| `push` (on the service worker) | Handles **every** push message the worker receives. Push To and legacy payloads are displayed; unknown shapes are logged with `console.warn` and ignored. |
| `chrome.notifications.onClicked` | Only for a notification the SDK showed: clears it, opens `data.url` in a new tab, reports `clicked` / `opened`, and clears the SDK's badge if the notification set one. A click on a notification your extension created itself is ignored: nothing is cleared, opened or reported. |
| `chrome.notifications.onClosed` (two listeners) | Only for a notification the SDK showed: reports `dismissed` when the user closed it, and removes the SDK's stored entry and auto-dismiss alarm. For any other notification nothing is reported or stored. |
| `chrome.alarms.onAlarm` | Acts only on alarms whose name starts with `pt-dismiss:`; every other alarm is ignored. |
| `chrome.action.onClicked` | Clears the toolbar badge text **if the SDK set it** and has not cleared it since. A badge your extension set is left alone. Only when the manifest has an `action` key. Chrome's [`action` reference](https://developer.chrome.com/docs/extensions/reference/api/action#event-onClicked) says this event is not dispatched for an action that has a popup. |
| `chrome.permissions.onAdded` / `onRemoved` | Acts only when `notifications` is in the list: on a grant it adds the notification listeners and registers with the remembered identity, if one was asked for and `unsubscribe()` was not called since; on a removal it forgets its cached registration. Chrome does not document that these events reach a service worker. |
| `chrome.runtime.onMessage` | Reacts to exactly one message, `{ type: 'pushto:permission-granted' }`, sent by `requestNotificationPermission()` from one of your own pages (the sender must be this extension), and does what a grant does. For every other message it returns `undefined` at once and never calls `sendResponse`, so your own `onMessage` listeners and their replies are unaffected. Do not use that message type yourself. |

The `chrome.notifications` listeners are added only while the extension
holds the `notifications` permission (see [Path B](#path-b-an-extension-that-already-has-users)).

**Which notifications are the SDK's.** The ones it created: an id it has an
entry for in `pt_notifications`, or one it created since the worker started.
Everything else belongs to your extension. Avoid creating notifications of
your own under a purely numeric id that could equal a Push To
`notification_id`.

**The toolbar badge.** The SDK sets it when a notification with `data.badge`
is shown (the text, and the colour if given) and records that in
`pt_badge`. It clears the badge only while that record exists: when that
notification is clicked, when the toolbar icon is clicked, and on a sign-out
or `unsubscribe()`. If your extension sets the badge after the SDK did, the
record is still there, so the next of those events clears it; do not send
`data.badge` if your extension uses the badge for something else.

**The push subscription.** A service worker has one push subscription. The
SDK creates it (`userVisibleOnly: true`, the platform's VAPID key), replaces
one that was made for another VAPID key, and removes it on `unsubscribe()`.
Do not use `pushManager` for another purpose in the same extension.

**Notification ids.** A Push To notification is shown under its
`notification_id` as a string (for example `"1234"`).

**Alarms.** Names start with `pt-dismiss:` (one per notification with
`data.auto_dismiss`, removed when it fires or the notification closes).

**Storage.** The SDK reads and writes only the keys below, and never calls
`clear()`. `chrome.storage.local` is readable by your extension's own
content scripts by default and is stored on disk unencrypted, so nothing
that works as a credential is put there: the identity proof (`hash`) and the
user's fields go to `chrome.storage.session`, which is limited to the
extension's trusted contexts by default and is emptied when the browser
closes (where a browser has no session storage they are kept in the worker's
memory only).

`chrome.storage.local`:

| Key | Content |
| --- | --- |
| `pt_anonymousId` | The random UUID of this browser's anonymous subscriber. Never deleted by the SDK. |
| `pt_registration` | The last successful registration: its time, a SHA-256 of everything that was sent (not the data itself), the ids the API answered (`userId`, `endpointId`), the external id, and a SHA-256 of the subscription's address and keys. |
| `pt_identity` | Which identity was last asked for: the user's `id` (absent for the anonymous subscriber) and whether more than the id was given. `{}` after `reset()`. Kept by `unsubscribe()`: it is what `subscribe()` registers. |
| `pt_vapidKey` | The VAPID public key read from the API, for up to 24 hours. |
| `pt_optedOut` | `true` after `unsubscribe()`, until `subscribe()`. |
| `pt_badge` | `true` while the toolbar badge is one the SDK set. |
| `pt_notifications` | The notifications currently on screen (title, message, link, badge, tag), so a click can be handled by a worker that started later. Entries are removed when the notification closes. |

`chrome.storage.session`:

| Key | Content |
| --- | --- |
| `pt_identity` | The fields last passed to `identify` / `registerPushSubscription`: `id`, `hash`, `email`, `name`, `imageUrl`, `language`. Removed by `reset()`. |

**Tabs.** Clicking a notification with a `data.url` opens that URL in a new
tab (`http:` and `https:` only).

## `userVisibleOnly`

The SDK subscribes with `userVisibleOnly: true` and displays every push it
can parse with `chrome.notifications.create`. Chrome's documentation does not
say whether a `chrome.notifications` notification counts as the user-visible
notification a `userVisibleOnly: true` subscription promises, and we have not
confirmed on a real device what Chrome does (for example, whether it ever
adds a notification of its own). If you see a notification you did not send,
please report it with your Chrome version. Silent push
(`userVisibleOnly: false`) exists for extensions from Chrome 121; the SDK
does not use it.

## API reference

### `new PushNotifications(options)`

```ts
interface PushSubscriptionOptions {
  apiKey: string;
  defaultNotificationIcon?: string;
  apiBaseUrl?: string;
  vapidPublicKey?: string;
}
```

| Option | Description |
| --- | --- |
| `apiKey` | Your browser key: a Push To API key **without** the `sending` / `admin` permission. |
| `defaultNotificationIcon` | Icon used for every notification. Wins over the notification's own `data.icon`. |
| `apiBaseUrl` | Host of the Push To API, **without** `/v1` (the SDK appends it; a trailing slash is fine). Overrides the host the package was built with. Must be `https:` (`http:` is accepted for loopback hosts only: `localhost`, `*.localhost`, `127.0.0.1`, `[::1]`, because the key travels in a header) and have no query or fragment. |
| `vapidPublicKey` | The platform's VAPID public key (base64url). When omitted, the SDK reads it from `GET /v1/vapid-key` and keeps it in `chrome.storage.local` for up to 24 hours. |

Must be called at the top level of the service worker. Throws only outside a
service worker or for an invalid `apiBaseUrl`; never because the
`notifications` permission is missing. Constructing it again in the same
worker adds no second listener and switches to the new options.

### Methods

| Method | Resolves to | Section |
| --- | --- | --- |
| `identify(user: User)` | `RegistrationResult` | [Identity](#identity) |
| `reset()` | `RegistrationResult` | [Identity](#identity) |
| `registerPushSubscription(user?: User)` | `RegistrationResult` | [Identity](#identity) (older name) |
| `getState()` | `PushState` | [Verify your integration](#verify-your-integration) |
| `sendTestNotification()` | `{ notificationId: number }` | [Verify your integration](#verify-your-integration) |
| `unsubscribe()` | `void` | [Lifecycle and deletion](#lifecycle-and-deletion) |
| `subscribe()` | `RegistrationResult` | [Lifecycle and deletion](#turn-notifications-back-on-subscribe) |

`identify`, `reset`, `registerPushSubscription`, `subscribe`, `unsubscribe`
and `sendTestNotification` run one at a time, in the order they were called, each
after the one before it has settled; one that failed does not stop the next.
So `identify` right after `reset`, or `sendTestNotification` right after
`identify`, needs no waiting or locking on your side.

From a page (`@push-to/chrome-extension/page`, also exported by the main
entry):

| Function | Resolves to |
| --- | --- |
| `requestNotificationPermission()` | `boolean`: whether the user granted `notifications`. Call it first in a click handler. |

```ts
interface User {
  id?: string | number; // required by identify(); a number must be a safe
                     // integer: pass a larger id as a string
  hash?: string;     // identity proof for `id`, computed by your server
  email?: string;
  name?: string;
  imageUrl?: string;
  language?: string;
}

interface PushState {
  permission: 'granted' | 'missing';
  subscribed: boolean;
  registered: boolean;
  optedOut: boolean;
  deliveryBlocked?: 'opted_out' | 'identity_change_pending';
  userId?: number;
  endpointId?: number;
  externalId?: string;
  anonymousId: string;
  registeredAt?: string; // ISO 8601
  apiBaseUrl: string;
  sdkVersion: string;
}
```

### Registration

A registration is one call, `POST /v1/subscriptions`, with the user's
`external_id` and the browser's push subscription
(`PushSubscription.toJSON()`). The API finds the user with that
`external_id`, or creates it, and registers the subscription for it, all or
nothing.

**How `User` maps to the API**

| `User` field | Sent as |
| --- | --- |
| `id` | `external_id`: a string with surrounding whitespace trimmed, a number as its decimal string. A number must be a safe integer (`Number.isSafeInteger`); any other number is rejected with a `TypeError`, so pass a larger id as a string. Without an `id` the SDK sends `anon:<anonymousId>`, so registering again reaches the same anonymous user instead of creating a new one. |
| `hash` | `user_hash`, only when an `id` is given. A `hash` without an `id` is dropped, with one `console.warn`. See [Identity verification](#identity-verification). |
| `email` | user `email`. Must be a valid address, or the API answers `422`. |
| `name` | split on the first run of whitespace into user `first_name` and `last_name` (`"Jane van der Berg"` → `Jane` / `van der Berg`; a single word is only a `first_name`). |
| `imageUrl` | subscription `metadata.image_url` |
| `language` | subscription `metadata.language` |

Absent and empty fields are left out.

**What is skipped.** The SDK first asks the browser for its existing push
subscription and reuses it; it only subscribes again when there is none, or
when the existing one was made for a different VAPID key (that one is
unsubscribed first). After a successful registration it stores the time and
a hash of everything it sent (API host, key, user fields, `hash`, endpoint,
subscription keys, metadata). While that hash is unchanged and the
registration is less than 24 hours old, the call makes no request and
resolves with `status: 'unchanged'`.

After 24 hours the call is sent again even if nothing changed. When
`vapidPublicKey` is not configured, the VAPID key is read again then, and on
any other full registration as well. That is how a browser recovers from
what it cannot see: a subscription the API disabled, a user removed on the
server, a rotated VAPID key (a configured key that was rotated has to be
changed in your code).

**Without the `notifications` permission** nothing is subscribed or sent:
Chrome makes every `pushManager` call fail at once without it, and shows no
prompt. The call resolves with `status: 'permission_required'`.

**When the permission is removed** (`chrome.permissions.remove`), the SDK
forgets its cached registration, so the next grant registers in full.

**A subscription the API refuses.** If the API answers
`409 endpoint_conflict` (the browser's push address is already registered
with different keys, which this browser's own registrations cannot cause),
the SDK unsubscribes, subscribes again and registers the new subscription,
once. A second refusal rejects the promise.

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

A message in the previous backend's shape is displayed too (see
[From 0.0.x](#from-00x)); one in any other shape is logged with
`console.warn` and ignored. Nothing is shown and nothing is reported either
for a message that arrives while the extension does not hold the
`notifications` permission, after `unsubscribe()`, or while the first
registration or a change of user has not been confirmed by the API (see
[Shared computers](#identity)). The same goes for a message that arrives
while the SDK cannot read that state from `chrome.storage.local`: it is
logged with `console.warn` and not shown.

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
import { PushToApiError } from '@push-to/chrome-extension';

try {
  await pushTo.identify({ id: 'user-123', email: 'not-an-email' });
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
| `404` | `subscription_not_found` | `sendTestNotification`: the API holds no active subscription with this browser's keys. |
| `409` | `endpoint_conflict` | The subscription's address is registered with different keys, and still was after the SDK replaced it once. |
| `410` | `subscription_gone` | `sendTestNotification`: the push service no longer knows the subscription. |
| `422` | `validation_error` | A field was refused, for example an invalid `email`. |
| `422` | `endpoint_limit_reached` | The user already has 20 active subscriptions. |
| `429` | `rate_limited` | `sendTestNotification`: a test was sent to this browser less than 30 seconds ago (`details.scope: "address"`), or your tenant reached its ceiling of test pushes (`details.scope: "tenant"`). `details.retry_after` is in seconds. |
| `502` | `push_failed` | `sendTestNotification`: the push service did not accept the message. |
| `503` | `identity_verification_unavailable` | The API deployment cannot check hashes at all. Not retried. |

Codes the SDK sets itself: `network_error` (the request failed, or got no
response within 10 seconds; `status` is `0`), `http_error` (a response
without the API's error body), `invalid_response` (a success without the
expected fields), and `subscription_not_found` with `status` `0` (
`sendTestNotification` was called while the browser has no push subscription;
no request was made). The 10-second timeout applies where the browser has
`AbortSignal.timeout`; without it only a failed request is a
`network_error`. A network error and a `503` are retried twice, with a short
backoff, before the call fails; nothing else is retried, and neither is
`503 identity_verification_unavailable`, which trying again cannot fix.
`sendTestNotification` is never retried, so one call sends at most one test.
A failed registration is not remembered, so the next call sends it again.

**A browser that shows nothing.** While `identify` keeps rejecting for a new
user (for example `403 invalid_user_hash`, or a `422`), the change of user is
never confirmed, so this browser displays no notifications at all (see
[Shared computers](#identity)). Handle the rejection, and check
`(await pushTo.getState()).deliveryBlocked`: it is `'identity_change_pending'`
in that state, `'opted_out'` after `unsubscribe()`, and absent when
notifications are displayed normally. It is also
`'identity_change_pending'` while the identity you asked for has no
successful registration yet, which includes a browser waiting for the
`notifications` permission (`status: 'permission_required'`).

`identify` rejects with a plain `TypeError` when `user.id` is missing, and
so do `identify` and `registerPushSubscription` when it is a number that is
not a safe integer.
`unsubscribe` does not reject for an API failure (see
[Lifecycle and deletion](#lifecycle-and-deletion)).

## Migrating

### From 1.0 to 1.1

1.1 is source compatible: code written for 1.0 compiles and runs. What
behaves differently:

- `registerPushSubscription` now resolves to a `RegistrationResult` instead
  of `void`. Prefer the new names `identify(user)` and `reset()`.
- `registerPushSubscription` no longer **rejects** without the
  `notifications` permission; it resolves with
  `status: 'permission_required'`. Code that relied on the rejection should
  check `status`.
- The first registration after the update is sent in full once (the cache
  entry written by 1.0 has no ids to answer with).
- The SDK now remembers the identity you last passed: the id in
  `chrome.storage.local` (`pt_identity`), the other fields (`hash` included)
  in `chrome.storage.session` only. 1.0 kept only a one-way hash of it.
- If you guarded the constructor for a missing `chrome.notifications`, or
  listened to `chrome.permissions.onAdded` to register, you can remove both.
- The SDK adds a `chrome.runtime.onMessage` listener that reacts only to its
  own message type, `pushto:permission-granted`.
- The SDK now ignores notifications your extension created itself (1.0
  cleared any notification of the extension on click), and clears the toolbar
  badge only if it set it (1.0 cleared it on every toolbar click). A badge
  that 1.0 set before the update is not cleared by 1.1 until the next
  notification with `data.badge`.
- When the signed-in user changes, and on `unsubscribe()`, the SDK's
  notifications still on screen are taken away. While a change of user has
  not been confirmed by the API, incoming notifications are not displayed;
  the same goes for an identity whose first registration has not succeeded
  yet. A browser that 1.0 had registered is not affected by that second
  rule: its notifications keep being displayed across the update.
- `unsubscribe()` and `subscribe()` are new. After `unsubscribe()`, only
  `subscribe()` registers again.
- `@types/chrome` and `@types/node` are no longer installed with the
  package. If your own code relied on getting them that way, add them to
  your `devDependencies`.

### From 0.0.x

Version 0.0.x talked to the previous Push To backend. Since 1.0 the SDK talks
to the Push To API (`/v1`), and that changes a few things:

- **API key.** Create a Push To API key with no permissions and use it as
  `apiKey`. Keys of the previous backend do not work.
- **Users must register again.** Subscriptions held by the previous backend are
  not carried over. Nothing to do if you already register on every
  service-worker start: the first run after the update registers the browser
  with the new API (subscribing again if the platform's VAPID key is not the
  one the old subscription was made for).
- **Registration is one call**, `POST /v1/subscriptions`. A key without
  permissions cannot call `POST /v1/users` or
  `POST /v1/users/{id}/endpoints`: those are for your server.
- **`User` fields are stored differently.** See
  [Registration](#registration): `name` becomes `first_name` / `last_name`,
  and `imageUrl` / `language` are stored on the subscription, not on the user.
- **`email` and `name` no longer update an existing user.** They are stored
  when the registration creates the user; after that, change them from your
  server.
- **`User.hash` is new.** It is needed once you turn on
  [identity verification](#identity-verification).
- **Registering without a `User` after a login is a logout**: the
  subscription moves back to the anonymous user (`reset()`).
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
  event for them. One gap: from your first `identify` / `reset` after the
  update until that first registration with the new API has succeeded
  (normally a moment; longer while it fails or waits for the permission),
  nothing is displayed, legacy messages included (see
  [Shared computers](#identity)).
- **Tracking.** `POST /notifications/track` is replaced by `POST /v1/feedback`
  with the events [listed above](#events-sent). There is no `auto-dismissed`
  event any more.
- **`host_permissions`** for the API host are not needed.

## Browser support

Chrome, Manifest V3. Push in an extension service worker needs Chrome 88 or
later.

## Development

```sh
git clone https://github.com/push-to/browser-extension-sdk.git
cd browser-extension-sdk
bun install
```

Build the package. The build needs `PUSHTO_CORE_URL`, the default host of
the Push To API **without** `/v1` (see `packages/chrome-extension/.env.example`):

```sh
PUSHTO_CORE_URL=https://your-push-api-host bun run build
```

Run the tests (mocked `chrome.*` and a fake API; no network) from
`packages/chrome-extension`:

```sh
PUSHTO_CORE_URL=https://your-push-api-host bun test
```

`tools/q5-smoke-extension/` is a throwaway extension for checking the SDK in
a real Chrome; its `STEPS.md` lists the manual steps.

This file is the package's README on npm: it is copied into
`packages/chrome-extension` when the package is packed (`prepack`).

### Releases

Releases are automated with
[semantic-release](https://github.com/semantic-release/semantic-release).
When a commit reaches `main`, the workflow works out the next version from
the commit messages, writes it to the package, builds the bundle with that
version (`tools/prepare-release.mjs`; the bundle reports it to the API as
`sdk_version`), updates the changelog, tags, publishes to npm and creates a
GitHub release.

Commit messages follow
[Conventional Commits](https://www.conventionalcommits.org/):

| Type | Release |
| --- | --- |
| `feat:` | minor (1.0.0 → 1.1.0) |
| `fix:`, `perf:`, `docs:`, `refactor:`, `revert:` | patch (1.0.0 → 1.0.1) |
| `chore:`, `test:`, `build:`, `ci:` | none |
| any type with `!` or a `BREAKING CHANGE:` footer | major (1.0.0 → 2.0.0) |

## License

MIT
