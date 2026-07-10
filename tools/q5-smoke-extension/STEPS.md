# Wave 1 — Q5 real-device MV3 smoke — manual steps

Scope: `core/docs/Specs/Phase 3 - PRD.md` §Wave 1, item 3.3f (Q5) + risk R3 +
acceptance criteria 1 and 2. Uses the real, built `@push-to/chrome-extension`
SDK (vendored in `vendor/pushto-chrome-extension.js`, rebuilt from the
current `feat/wave-1-mv3-hardening` tree — includes the W1-G fix, see step 5
below), pointed at the live production core (`https://api.pushto.ai`) since
Wave 0's broadcast correlation scheme is deployed there.

**Status: the mocked-chrome unit checks (`src/lib/__tests__/mv3-durability.test.ts`)
found a HIGH-severity regression (click/close listeners not wired at
top-level SW init) and it has since been fixed in-source and re-verified
(8/8 tests green, build+typecheck green). Step 5 below is now a
*confirmation* that the fix holds on a real device, not a bug hunt — but
still worth running since mocked tests can't fully substitute for real
Chrome MV3 wake-event semantics.

**Blocker: needs a real PushTo admin API key.** `POST /notifications` is
`admin: true` in `apps/supabase-functions/.../notifications/router.ts`. None
was available in this environment (no key found in local env/`.env` files
anywhere under `~/dev/push-to`) — do not fake or guess one. Ask the lead for
a test key, then follow the steps below.

## 0. Set the key

Edit `background.js` locally, replace:
```js
const PUSHTO_API_KEY = 'REPLACE_WITH_REAL_ADMIN_API_KEY';
```
with the real key. **Do not commit this change** — this repo's working tree
already carries an unrelated uncommitted Wave 1 diff; never stage/commit
anything in it.

## 1. Load the extension

1. `chrome://extensions` → enable **Developer mode**.
2. **Load unpacked** → select `tools/q5-smoke-extension/`.
3. Click **service worker** on the extension's card to open its DevTools
   console.
4. Confirm no errors on load, and (once the key is set) see
   `[PT-Q5] registerPushSubscription OK` and, in the Network tab,
   `POST https://api.pushto.ai/subscriptions` → 200.
   - This alone proves R3: `pushManager.subscribe()` (called internally by
     `registerPushSubscription`) works in an MV3 background SW with only
     `notifications`/`alarms`/`storage` permissions, no `gcm_sender_id`.
   - It also exercises 3.3c (`{ email }`, no `id`) — confirm no 422.

## 2. Killing the SW — primary tool is `chrome://serviceworker-internals`

Every step below that needs to force-terminate the background worker (to get
a genuinely fresh, no-prior-listeners realm rather than just a "still warm"
one) uses this:

1. Open `chrome://serviceworker-internals` in a tab (or
   `chrome://serviceworker-internals/?devtools` to auto-open DevTools).
2. Find this extension's worker (origin is
   `chrome-extension://<extension-id>/`, extension id shown on its
   `chrome://extensions` card).
3. Click **Stop** to terminate it immediately.
4. Cross-check on `chrome://extensions`: the card's "service worker" state
   flips to *Inactive*; the next event (click, alarm, push) re-spawns it and
   a fresh "service worker" inspector link appears.

## 3. Send a broadcast (Wave 0's actual target — preferred over plain notifications)

Wave 0's correlation-token scheme is specifically about **broadcasts**
(`POST /broadcasts` → `POST /broadcasts/:id/send`), so prefer this path to
also validate that end-to-end, not just the SDK's click/dismiss durability.

```sh
# 1. Create (or reuse) an audience that includes this test subscriber.
# NOTE: audience-membership mechanics (which subscribers match an audience)
# aren't something I could confirm from the SDK repo alone -- confirm with
# the lead/backend which audienceId already covers this subscriber, or how
# to add it, before running this.
curl -i https://api.pushto.ai/audiences \
  -H "Authorization: Bearer <REAL_ADMIN_API_KEY>" \
  -H "Content-Type: application/json" \
  -d '{ "name": "wave1-q5-smoke" }'

# 2. Create the broadcast against that audienceId.
curl -i https://api.pushto.ai/broadcasts \
  -H "Authorization: Bearer <REAL_ADMIN_API_KEY>" \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Wave 1 Q5 broadcast smoke",
    "body": "click me",
    "link": "https://example.com/deep-link",
    "audienceId": <AUDIENCE_ID>
  }'

# 3. Send it (broadcastId from step 2's response).
curl -i https://api.pushto.ai/broadcasts/<BROADCAST_ID>/send \
  -H "Authorization: Bearer <REAL_ADMIN_API_KEY>" \
  -H "Content-Type: application/json" \
  -d '{ "broadcastId": <BROADCAST_ID> }'
```

If audience targeting is a blocker on the day, `POST /notifications` (below)
is a valid fallback for exercising the click/dismiss durability paths — the
SDK-side bug in step 5 is client-only and identical either way; it just
won't additionally validate Wave 0's broadcast correlation-token resolution.

```sh
curl -i https://api.pushto.ai/notifications \
  -H "Authorization: Bearer <REAL_ADMIN_API_KEY>" \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Wave 1 Q5 smoke",
    "body": "click me while the worker is warm",
    "link": "https://example.com/deep-link",
    "badge": { "text": "1", "color": "#ff0000" },
    "autoDismissOptions": { "behavior": "timed", "dismissTimeMS": 10000 }
  }'
```

## 4. Happy path — click while the worker is still warm (AC1, literal case)

1. Send per step 3 (broadcast, or the notification fallback).
2. As soon as the notification appears, click it immediately (no SW kill).
3. Expect: link opens in a new tab, toolbar badge clears, and either
   `POST /notifications/track` or `POST /broadcasts/.../track` (whichever
   send path you used) fires with `status: "clicked"` (check Network tab).

## 5. Real-device confirmation — click AFTER the worker is killed (W1-G fix verification)

This is a real-device confirmation of a HIGH-severity regression found by
the mocked-chrome unit tests (`src/lib/__tests__/mv3-durability.test.ts`):
`chrome.notifications.onClicked` was only wired up lazily inside
`showNotification()`/`fireDismissIfPresent()`, never at
`ReceiveNotification.initialize()` — unlike `Dismiss`, whose listeners were
already correctly registered at top-level SW startup. **This has since been
fixed in-source** (`receive-notification.ts` now also calls
`PushNotificationEvents.getInstance(apiKey)` at top-level init, alongside
`Dismiss.instance.registerListeners(apiKey)`) and re-verified by the unit
tests (8/8 green). This step confirms the fix holds under real Chrome MV3
wake-event semantics, not just the mock.

1. Send another notification/broadcast per step 3.
2. Let it render, then immediately kill the SW per step 2
   (`chrome://serviceworker-internals` → Stop).
3. Click the still-visible notification.
4. **Expected (fix verified):** link opens in a new tab, toolbar badge
   clears, and a track POST with `status: "clicked"` appears in the Network
   tab of the freshly-spun-up SW inspector — even though the SW had been
   fully terminated between the notification rendering and the click.
5. **If this fails on real Chrome despite the mocked tests being green**,
   that's a real finding in its own right (mock/reality divergence in MV3
   wake-event dispatch) — capture the exact repro and escalate immediately.

## 6. Auto-dismiss durability — `<30s` and `>=60s` buckets (AC2, 3.3b)

**`<30s` (hybrid setTimeout path):**
1. Send a notification/broadcast with a `10000`ms (`<30s`) timed
   auto-dismiss.
2. Immediately kill the SW per step 2.
3. Because the delay is under Chrome's 30s alarm floor, the SDK also
   schedules a `setTimeout` — but that timer dies with the terminated
   worker. Confirm whether the notification still auto-dismisses via the
   clamped 30s backstop alarm (it should, at ~30s, not ~10s — the
   `setTimeout` precision is lost once the worker is killed, but the alarm
   backstop should still fire the dismiss). Note the actual elapsed time
   before dismissal.

**`>=60s` (pure alarm path):**
1. Send a notification/broadcast with a `65000`ms (`>=60s`) timed
   auto-dismiss.
2. Immediately kill the SW per step 2.
3. Wait ~65s. Confirm the notification auto-dismisses and a
   `status: "auto-dismissed"` track event fires even though the SW was dead
   in between — this is the literal AC2 scenario.

## 7. Tenant isolation sanity

Ask database-engineer (or query with a service-role connection) to confirm
the `track_notifications`/`track_broadcasts` rows from steps 4–6 have the
correct `customer_id` for the key used, and no cross-tenant rows appear.

## Reporting

For each step capture: Chrome version (`chrome://version`), exact console
log lines, Network tab status codes/bodies, and the SW state transitions in
`chrome://serviceworker-internals` (RUNNING → STOPPED → RUNNING). File
findings with this doc's step number as the repro.
