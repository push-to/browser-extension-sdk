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

1. In your background script, initialize the Push To extension:

```typescript
// background.js

import { PushToExtension } from '@push-to/chrome-extension';

const pushTo = new PushToExtension({
  apiKey: 'your-api-key',
  // Optional: Default notification options
  defaultNotificationIcon: 'https://example.com/icon.png'
});
```

2. Register for push notifications:

```typescript
// background.js

await pushTo.registerPushSubscription();
```

## API Reference

### PushToExtension

#### Constructor Options

```typescript
interface PushSubscriptionOptions {
  apiKey: string; // Required: Your Push To API key
  defaultNotificationIcon?: string;
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