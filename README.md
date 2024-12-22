# Push To Chrome Extension

<div align="center"><strong>Push To Chrome Extension</strong></div>
<div align="center">A modern way to handle push notifications in Chrome Extensions.<br />Simple, type-safe, and easy to integrate.</div>
<br />

## Introduction

A TypeScript library for handling push notifications in Chrome Extensions with ease. It takes care of service worker registration, push subscription management, and provides a clean API for handling notifications.

## Features

- 🔒 Secure handling of VAPID keys
- 🔄 Automatic service worker registration
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

1. Initialize the Push To extension in your Chrome Extension:

```typescript
import { PushToExtension } from '@push-to/chrome-extension';

const pushTo = new PushToExtension({
  apiKey: 'your-api-key'
});
```

2. Register for push notifications:

```typescript
// In your popup or background script
document.getElementById('subscribe-button').addEventListener('click', async () => {
  try {
    await pushTo.registerPushSubscription();
    console.log('Successfully subscribed to push notifications!');
  } catch (error) {
    console.error('Failed to subscribe:', error);
  }
});
```

3. Handle incoming notifications in your background script:

```typescript
// background.js
self.addEventListener('push', (event) => {
  const data = event.data?.json() ?? {};
  
  self.registration.showNotification(data.title ?? 'New Notification', {
    body: data.body ?? 'You have a new message',
    icon: data.icon,
    data: data
  });
});
```

## API Reference

### PushToExtension

#### Constructor Options

```typescript
interface PushSubscriptionOptions {
  apiKey: string;               // Required: Your Push To API key
}
```

#### Methods

- `registerPushSubscription(localRegistration?: ServiceWorkerRegistration): Promise<void>`
  - Registers the service worker and sets up push notifications

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

3. Build the package:
```bash
pnpm build
```

4. For local testing:
```bash
pnpm dev
```

## Contributing

Contributions are welcome! Please read our contributing guidelines before submitting a pull request.

## License

MIT License