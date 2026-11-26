# Q5 real-device MV3 smoke — manual steps (push-api)

A real-Chrome check of what the mocked tests
(`packages/chrome-extension/src/lib/__tests__/`) cannot prove: MV3 wake-event
dispatch after the service worker has been terminated, and the round trip
through push-api (`core/apps/push-api`).

> **The vendored bundle is stale.** `vendor/pushto-chrome-extension.js` was
> built from 0.0.16 and still talks to the previous backend
> (`/subscriptions`, `/notifications/track`). Rebuild and re-copy it (step 0)
> before running anything below. Do not hand-edit it.

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
```

Then edit `background.js` locally and replace the placeholder
`'REPLACE_WITH_REAL_ADMIN_API_KEY'` with the **browser** key (the placeholder's
name predates push-api; an admin key is no longer what goes here). Remove the
`defaultNotificationIcon` line if you want to exercise `data.icon` (the default
icon wins over it). **Do not commit that change.**

## 1. Load the extension and register

1. `chrome://extensions` → enable **Developer mode** → **Load unpacked** →
   select `tools/q5-smoke-extension/`.
2. Click **service worker** on the extension's card to open its DevTools.
3. Expect `[PT-Q5] registerPushSubscription OK` in the console and, in the
   Network tab, in this order:
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
4. Read the push-api user id, which the sends below need: it is the `user_id`
   in the response of `POST /v1/subscriptions` (Network tab → Response).

   ```sh
   export PUSHTO_USER_ID=<that number>
   ```
5. **Re-registration is skipped.** Reload the extension (or stop the worker,
   step 2, and wake it). `registerPushSubscription OK` is logged again and the
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

## Reporting

For each step capture: Chrome version (`chrome://version`), the console lines,
the Network tab's status codes and request bodies, and the worker's state
transitions in `chrome://serviceworker-internals` (RUNNING → STOPPED →
RUNNING). File findings with this document's step number as the repro.
