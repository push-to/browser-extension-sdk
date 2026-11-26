# Q5 real-device MV3 smoke — manual steps (push-api)

A real-Chrome check of what the mocked tests
(`packages/chrome-extension/src/lib/__tests__/`) cannot prove: MV3 wake-event
dispatch after the service worker has been terminated, and the round trip
through push-api (`core/apps/push-api`).

> **The vendored bundle is stale.** `vendor/pushto-chrome-extension.js` was
> built from 0.0.16 and still talks to the previous backend
> (`/subscriptions`, `/notifications/track`); it has none of `identify`,
> `reset`, `getState`, `sendTestNotification` or `unsubscribe`. Rebuild and
> re-copy it (step 0) before running anything below. Do not hand-edit it.

You need two push-api keys of the same tenant, and the push-api host. Keep all
three in your shell, never in a file in this repo:

```sh
export PUSH_API_URL=...            # push-api host, no /v1 and no trailing slash
export PUSHTO_BROWSER_KEY=...      # a key with NO permissions: goes in the extension
export PUSHTO_SENDING_KEY=...      # a key with the `sending` permission: curl only
```

The sending key must never be put in `background.js`: everything in an
extension is readable by whoever installs it.

## 0. Build the SDK and point the harness at push-api

```sh
cd packages/chrome-extension
PUSHTO_CORE_URL="$PUSH_API_URL" bunx tsup
cp dist/index.js ../../tools/q5-smoke-extension/vendor/pushto-chrome-extension.js
cp dist/index.js.map ../../tools/q5-smoke-extension/vendor/pushto-chrome-extension.js.map
cp dist/page.js ../../tools/q5-smoke-extension/vendor/pushto-page.js
```

`dist/index.js` and `dist/page.js` are each one self-contained file.
`vendor/pushto-page.js` is the page helper used by `permission.html`
(step 10); it is not committed.

Then edit `background.js` locally and replace the placeholder
`'REPLACE_WITH_REAL_ADMIN_API_KEY'` with the **browser** key (the placeholder's
name predates push-api; an admin key is no longer what goes here). Remove the
`defaultNotificationIcon` line if you want to exercise `data.icon` (the default
icon wins over it). **Do not commit that change.**

## 1. Load the extension and register

1. `chrome://extensions` → enable **Developer mode** → **Load unpacked** →
   select `tools/q5-smoke-extension/`.
2. Click **service worker** on the extension's card to open its DevTools.
3. Expect `[PT-Q5] registerPushSubscription OK` in the console, followed by
   the result (`{ status: "registered", userId, endpointId, externalId:
   "anon:<uuid>" }`), and, in the Network tab, in this order:
   - `GET  $PUSH_API_URL/v1/vapid-key` → `200`
   - `POST $PUSH_API_URL/v1/subscriptions` → `201` (`200` if this user already
     had the subscription). Body: `external_id: "anon:<uuid>"`, the harness's
     `email`, `subscription: { endpoint, expirationTime, keys }` and
     `metadata.channel: "extension"`; no `user_hash`.

   There must be **no** request to `/v1/users` or `/v1/users/<id>/endpoints`:
   a browser key gets `403 insufficient_permissions` there.

   This proves `pushManager.subscribe()` works in an MV3 background worker with
   only the `notifications` / `alarms` / `storage` permissions, and that
   push-api's CORS lets the worker call it with no `host_permissions`.
4. Read the push-api user id, which the sends below need: it is `userId` in
   the logged result (and `user_id` in the response of
   `POST /v1/subscriptions`), or `(await pushTo.getState()).userId` in the
   service worker console.

   ```sh
   export PUSHTO_USER_ID=<that number>
   ```
5. **Re-registration is skipped.** Reload the extension (or stop the worker,
   step 2, and wake it). `registerPushSubscription OK` is logged again, now
   with `status: "unchanged"` and the same ids, and the
   Network tab shows **no request at all**: the registration and the VAPID key
   are both remembered for 24 hours.
6. **It expires.** In the service worker console, age the stored registration,
   then reload the extension: both requests of step 1.3 are sent again.

   ```js
   const { pt_registration } = await chrome.storage.local.get('pt_registration');
   await chrome.storage.local.set({
     pt_registration: { ...pt_registration, registeredAt: Date.now() - 25 * 3600e3 },
   });
   ```

7. **Identity (optional).** In `background.js`, pass
   `{ id: 'q5-user', email: ... }` to `registerPushSubscription` and reload:
   one `POST /v1/subscriptions` with `external_id: "q5-user"` and a different
   `user_id` in the response (use that one for the sends below). Add
   the real `hash` for that id (computed with the tenant's identity secret,
   on your machine, never in the extension) and reload again: the same
   request with `user_hash`, still `2xx`. Change one digit of the hash and
   reload: `403 invalid_user_hash`, exactly one request (no retry), logged by
   the harness as a failed registration and sent again on the next reload
   (nothing is cached). If the tenant has no identity secret yet, any hash
   answers that `403`.
   Remove the `User` argument and reload: the subscription moves back to the
   `anon:<uuid>` user.

## 2. Killing the service worker

Every step that needs a genuinely fresh worker (no listeners left over from the
one that showed the notification) uses this:

1. Open `chrome://serviceworker-internals`.
2. Find this extension's worker (`chrome-extension://<extension-id>/`; the id
   is on its `chrome://extensions` card).
3. Click **Stop**.
4. Cross-check on `chrome://extensions`: the card's "service worker" flips to
   *Inactive*; the next event (click, alarm, push) starts it again.

## 3. Send a notification

```sh
curl -i "$PUSH_API_URL/v1/notifications" \
  -H "Authorization: Bearer $PUSHTO_SENDING_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "user_id": '"$PUSHTO_USER_ID"',
    "title": "Q5 smoke",
    "body": "click me",
    "data": {
      "url": "https://example.com/deep-link",
      "badge": { "text": "1", "color": "#ff0000" }
    }
  }'
```

Expect a `2xx` whose body lists the notification(s) created (one per active
endpoint of the user). The id of each is the `notification_id` of its feedback
events and the id of the Chrome notification.

Variants used below — replace `data` with:

```jsonc
// auto-dismiss, under Chrome's 30 s alarm floor
{ "url": "https://example.com/deep-link", "auto_dismiss": { "behavior": "timed", "dismiss_time_ms": 10000 } }
// auto-dismiss, alarm only
{ "url": "https://example.com/deep-link", "auto_dismiss": { "behavior": "timed", "dismiss_time_ms": 65000 } }
// tag replacement: send twice
{ "tag": "q5", "context_message": "replaces the previous one" }
// unsafe click target: must open nothing
{ "url": "javascript:alert(1)" }
// icon from the payload (only if background.js sets no defaultNotificationIcon)
{ "icon": "https://www.google.com/favicon.ico" }
```

To read back what was recorded (sending key only):

```sh
curl -s "$PUSH_API_URL/v1/users/$PUSHTO_USER_ID/feedback" \
  -H "Authorization: Bearer $PUSHTO_SENDING_KEY"
```

## 4. Happy path — click while the worker is warm

1. Send per step 3.
2. The notification appears and the toolbar badge shows `1`. Network tab:
   `POST /v1/feedback` → `202 {"accepted":true}` with
   `event_type: "delivered"` and a numeric `notification_id` (no `occurred_at`:
   push-api stamps the time).
3. Click the notification. Expect: the link opens in a new tab, the badge
   clears, and two more `POST /v1/feedback`: `clicked`, then `opened`. **No**
   `dismissed`.

## 5. Click AFTER the worker is killed

1. Send per step 3. Let it render, then kill the worker (step 2).
2. Click the still-visible notification.
3. Expected: the link opens, the badge clears, and `clicked` + `opened` appear
   in the Network tab of the freshly started worker. The notification's state
   came from `chrome.storage.local`, and the click reached a listener
   registered at top-level startup.
4. If this fails on real Chrome while the mocked tests are green, that is a
   finding in its own right (mock/reality divergence in MV3 wake-event
   dispatch): capture the exact repro and escalate.

## 6. Close by the user

1. Send per step 3 and close the notification with its ✕ (do not click it).
2. Expected: one `POST /v1/feedback` with `event_type: "dismissed"`.
3. Repeat with the worker killed before closing. Record whether Chrome wakes
   the worker for `onClosed` and whether `dismissed` is sent — this path has
   not been verified on a real device.
4. **`byUser`.** The SDK sends `dismissed` only when `onClosed` reports
   `byUser === true`. For each way of getting rid of a notification on this OS
   (✕ on the banner, clearing it from the notification centre, "clear all",
   letting the banner time out, Do Not Disturb), record whether `dismissed` is
   sent. To see the raw value, add in the service worker console:

   ```js
   chrome.notifications.onClosed.addListener((id, byUser) => console.log('[PT-Q5] onClosed', id, byUser));
   ```

   Run this on macOS and Windows: it decides whether `byUser` can be relied
   on.

## 7. Auto-dismiss durability

**`< 30 s` (hybrid `setTimeout` + alarm):**
1. Send the `10000` ms variant and leave the worker alone: the notification
   goes away at ~10 s.
2. Send it again and kill the worker at once. The `setTimeout` dies with the
   worker; the notification should go away at ~30 s through the clamped alarm.
   Note the actual time.

**`>= 60 s` (alarm only):**
1. Send the `65000` ms variant and kill the worker at once.
2. At ~65 s the notification goes away although the worker was dead.

In all three cases **no** feedback is sent for the dismissal: the only event
for the notification is `delivered`.

## 8. Tag replacement, unsafe URL, icon

- **Tag.** Send the `tag` variant twice. The first notification disappears
  when the second arrives; each has a `delivered` and neither a `dismissed`.
- **Unsafe URL.** Send the `javascript:` variant and click it: no tab opens,
  `clicked` is sent, `opened` is not.
- **Icon.** With no `defaultNotificationIcon` in `background.js`, send the
  `icon` variant and record whether the notification shows that icon or falls
  back to the built-in one: the harness has no `host_permissions` for the
  icon's host, so Chrome loading it is not guaranteed. Either way the
  notification must appear. Send one with no icon: the harness manifest
  declares no `icons`, so the built-in transparent icon is used and the
  notification must still appear.

## 9. Tenant isolation sanity

With the sending key of **another** tenant, `GET
/v1/users/$PUSHTO_USER_ID/feedback` must answer `404`, and a `POST
/v1/feedback` for one of the notification ids above must answer `404`.

## 10. Optional `notifications` permission

This is the flow for an extension that already has users. None of what Chrome
does here is documented in full, so **record what you see at every step**,
with the Chrome version; each "record" below is an open question.

1. Edit `manifest.json` locally (do not commit): move `"notifications"` from
   `"permissions"` to a new `"optional_permissions": ["notifications"]`.
   Remove the extension and load it again, so it starts without the grant.
2. Service worker console. Expected: no error from the top-level
   `new PushNotifications(...)`, and
   `registerPushSubscription OK { status: "permission_required", externalId: "anon:…" }`.
   Network tab: **no request**.
   - Record: `typeof chrome.notifications` (expected `"undefined"`).
   - `await pushTo.getState()` → `permission: "missing"`, `subscribed: false`,
     `registered: false`, `externalId: "anon:…"`.
   - `await chrome.storage.local.get('pt_identity')` → `{ details: true }`
     only; the harness's email is in
     `await chrome.storage.session.get('pt_identity')`.
3. Open `chrome-extension://<extension-id>/permission.html` in a tab and
   click **Enable notifications**. Accept Chrome's prompt. The page shows
   `granted: true`.
4. **Without reloading the extension**, back in the service worker console
   (the worker must be the same one: check it was not restarted in
   `chrome://serviceworker-internals`):
   - Network tab: `GET /v1/vapid-key` and `POST /v1/subscriptions` → `2xx`,
     sent by the SDK on the grant. It has two triggers: its
     `permissions.onAdded` listener, and the message
     `{ type: 'pushto:permission-granted' }` that `permission.js` sends
     through `requestNotificationPermission()`. **Record which arrived**:
     before step 3 add, in the service worker console,
     `chrome.runtime.onMessage.addListener((m) => console.log('[PT-Q5] message', m))`
     next to the `onAdded` logger below. Then repeat the step once with the
     message suppressed (grant with
     `chrome.permissions.request({ permissions: ['notifications'] })` typed
     into the page's console after a click on the page) to see whether
     `onAdded` alone is enough.
   - `await pushTo.getState()` → `permission: "granted"`, `subscribed: true`,
     `registered: true`, with `userId` and `endpointId`.
   - Record: whether `chrome.notifications` is now defined in this running
     worker; whether `permissions.onAdded` fired at all (add
     `chrome.permissions.onAdded.addListener((p) => console.log('[PT-Q5] onAdded', p))`
     before step 3 to see it); and, if the registration failed, the exact
     error name and message logged as
     `[PushTo] could not register after the notifications permission was granted`.
   - If nothing was registered: reload the extension. The top-level
     `registerPushSubscription` must register now. Record that this was
     needed.
5. Repeat steps 1 to 3 with the worker **stopped** (step 2 of "Killing the
   service worker") before clicking the button. Record whether the grant
   wakes the worker and the registration happens, or only the next start
   registers.
6. Send a notification (step 3 of this document) and click it: it must be
   displayed, open its link and report `delivered`, `clicked`, `opened`. Do it
   once in the worker that received the grant and once after stopping the
   worker.
7. **Removal.** In the service worker console:
   `await chrome.permissions.remove({ permissions: ['notifications'] })`.
   Expected: `pt_registration` is gone from `chrome.storage.local`, no request
   is made, `getState()` shows `permission: "missing"`. Grant again from
   `permission.html`: a full registration is sent.
8. **Update flow (the reason for all this).** Not covered by an unpacked
   extension: with a packed build installed from a store or a local update
   URL, publish an update that adds `notifications` to `optional_permissions`
   only, and confirm the extension stays enabled. Then one that adds it to
   `permissions`, and confirm Chrome disables the extension until the user
   accepts.

## 11. `sendTestNotification`

With the extension registered (step 1, or step 10.4):

1. `await pushTo.sendTestNotification()` → `{ notificationId: <number> }`,
   Network tab: `POST /v1/subscriptions/test` → `200`.
2. A notification "Test notification" / "Push notifications are working in
   this browser." appears, followed by `POST /v1/feedback` (`delivered`) →
   `202`. Click it: `clicked` → `202`, no tab opens (it has no `url`).
3. Call it again at once: it rejects with `PushToApiError`, `status: 429`,
   `code: "rate_limited"`, `details.retry_after` between 1 and 30.
4. `GET /v1/users/$PUSHTO_USER_ID/feedback` (step 3) lists no event for the
   test notification.
5. After `await pushTo.unsubscribe()` (step 13), call it again: it rejects
   with `code: "subscription_not_found"`, `status: 0`, and no request.

## 12. `identify` and `reset` (detaching a user)

1. `const a = await pushTo.identify({ id: 'q5-user' })` → `status:
   "registered"`, `externalId: "q5-user"`. Note `a.userId`.
2. Send a notification to `a.userId` (step 3): it is displayed.
3. `const b = await pushTo.reset()` → `status: "registered"`,
   `externalId: "anon:<uuid>"`, a different `userId`. Network tab: one
   `POST /v1/subscriptions` with the **same** `subscription` as in 1.
   `await chrome.storage.local.get('pt_identity')` → `{ pt_identity: {} }`,
   and `await chrome.storage.session.get('pt_identity')` → `{}`.
4. Send to `a.userId` again: the answer is `422 no_endpoints` (or lists no
   `sent` entry) and **nothing is displayed**. Send to `b.userId`: displayed.
5. `await pushTo.identify({})` rejects with a `TypeError` and makes no
   request.
6. **Screen is cleared on sign-out.** `await pushTo.identify({ id:
   'q5-user' })`, send two notifications to that user (one with the `badge`
   of step 3) and leave them on screen. Create one of your own:
   `chrome.notifications.create('mine', { type: 'basic', iconUrl:
   'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
   title: 'mine', message: 'not the SDK\'s' })`. Then `await pushTo.reset()`:
   the two Push To notifications disappear and the badge clears, with **no**
   `dismissed` in the Network tab; `mine` stays. Click `mine`: it stays on
   screen and nothing is sent. Set a badge by hand
   (`chrome.action.setBadgeText({ text: 'X' })`) and click the toolbar icon:
   it stays.

7. **Sign-out while offline.** `await pushTo.identify({ id: 'q5-user' })`,
   switch the Network tab to *Offline*, `await pushTo.reset()` (it rejects
   with `network_error`), go back online **without** calling `reset()`
   again, and send to the `q5-user` id: the API reports `sent`, **nothing is
   displayed**, no feedback is posted, and the console shows
   `[PushTo] a push message arrived while a change of user is not yet registered: nothing is shown`.
   Then `await pushTo.reset()` → `registered`; a send to the anonymous
   `userId` is displayed.

## 13. `unsubscribe`

1. `await pushTo.unsubscribe()`. Network tab: `DELETE /v1/subscriptions` →
   `204`, with `{ subscription: { endpoint, expirationTime, keys } }`.
2. `await pushTo.getState()` → `subscribed: false`, `registered: false`,
   `optedOut: true`. `await chrome.storage.local.get(null)` shows no
   `pt_registration` or `pt_vapidKey`.
3. Send to the user (step 3): `422 no_endpoints`, nothing displayed.
4. **It stays off.** Reload the extension, with the top-level
   `registerPushSubscription` call in place: it logs
   `{ status: "unsubscribed", externalId: … }` and makes **no request**.
   With the optional-permission manifest of step 10, remove and grant the
   permission again: no request either.
5. **Offline.** Register again (`await pushTo.subscribe()`), switch the Network
   tab to *Offline*, `await pushTo.unsubscribe()`: it resolves, logs
   `[PushTo] could not remove the subscription from the API…`, and
   `getState()` shows `subscribed: false`. Back online, send to the user: the
   API reports the endpoint as failed (`subscription gone`) and a second send
   is `422 no_endpoints`. Record whether the first send displayed anything
   (it must not).
6. `await pushTo.subscribe()` registers again (`status: "registered"`, the
   identity last given) and `optedOut` is `false`. `reset()` / `identify()`
   alone do not.

## Reporting

For each step capture: Chrome version (`chrome://version`), the console lines,
the Network tab's status codes and request bodies, and the worker's state
transitions in `chrome://serviceworker-internals` (RUNNING → STOPPED →
RUNNING). File findings with this document's step number as the repro.
