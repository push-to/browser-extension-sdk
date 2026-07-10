// PushTo Wave 1 - Q5 real-device smoke — background service worker.
//
// Loads the REAL built SDK bundle (vendored from
// packages/chrome-extension/dist/index.js at the time this harness was
// prepared, built against PUSHTO_CORE_URL=https://api.pushto.ai — the live
// production core, since Wave 0's broadcast correlation scheme is deployed
// there). If the SDK source changes, rebuild it and re-copy:
//   cd packages/chrome-extension && PUSHTO_CORE_URL=https://api.pushto.ai bunx tsup
//   cp dist/index.js dist/index.js.map ../../tools/q5-smoke-extension/vendor/
//
// PUSHTO_API_KEY is a PLACEHOLDER. This file must never contain a real
// secret. Replace the placeholder locally on your machine only, and do not
// commit that change.
import { PushNotifications } from './vendor/pushto-chrome-extension.js';

const PUSHTO_API_KEY = 'REPLACE_WITH_REAL_ADMIN_API_KEY';

if (PUSHTO_API_KEY === 'REPLACE_WITH_REAL_ADMIN_API_KEY') {
  console.log(
    '[PT-Q5] No real API key set — background.js loaded and the SW registered ' +
      'correctly (top-level init did not throw), but registerPushSubscription() ' +
      'was skipped. Set PUSHTO_API_KEY locally to run the full flow. See STEPS.md.',
  );
} else {
  // Top-level, synchronous init — required by the SDK (see README): MV3 only
  // delivers wake events to listeners registered synchronously at worker
  // startup.
  const pushTo = new PushNotifications({
    apiKey: PUSHTO_API_KEY,
    defaultNotificationIcon: 'https://api.pushto.ai/favicon.ico',
  });

  // Anonymous + email-only (no `id`) subscriber — also exercises Wave 1 item
  // 3.3c (core's `User.id` now optional).
  pushTo
    .registerPushSubscription({ email: 'wave1-q5-real-device@example.com' })
    .then(() => console.log('[PT-Q5] registerPushSubscription OK'))
    .catch((e) => console.log('[PT-Q5] registerPushSubscription FAILED:', e && e.message));
}
