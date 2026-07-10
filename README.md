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
> the `tabs` permission. The empty `"action": {}` key is needed so the SDK can
> set/clear the toolbar badge.

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
>   runs at startup. Initializing lazily would leave a re-woken worker unable to
>   report the auto-dismiss event.

```typescript
// background.js — runs at the top level of the service worker

import { PushNotifications } from '@push-to/chrome-extension';

const pushTo = new PushNotifications({
  apiKey: 'your-api-key',
  // Optional: default icon used for every notification
  defaultNotificationIcon: 'https://example.com/icon.png'
});
```

3. Register for push notifications:

```typescript
// background.js

// Anonymous subscriber:
await pushTo.registerPushSubscription();

// Or associate the subscriber with a user:
await pushTo.registerPushSubscription({
  id: 'user-123',
  email: 'jane@example.com',
  name: 'Jane Doe'
});
```

## API Reference

### PushNotifications

#### Constructor Options

```typescript
interface PushSubscriptionOptions {
  apiKey: string; // Required: Your Push To API key
  defaultNotificationIcon?: string; // Optional: default notification icon
}
```

#### Methods

- `registerPushSubscription(user?: User): Promise<void>`
  - Registers the push subscription with Push To. Pass an optional `User` to
    associate the subscriber with an identity; omit it for an anonymous
    subscriber.

```typescript
interface User {
  id?: string;
  email?: string;
  name?: string;
  imageUrl?: string;
  language?: string;
}
```

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