// Page side of the optional-permission flow (STEPS.md, step 10). The helper
// is the built `dist/page.js`, copied in step 0.
import { requestNotificationPermission } from './vendor/pushto-page.js';

const out = document.querySelector('#out');

document.querySelector('#enable').addEventListener('click', async () => {
  // First call in the handler: the request needs the user gesture.
  const granted = await requestNotificationPermission();
  out.textContent = `granted: ${granted}`;
});
