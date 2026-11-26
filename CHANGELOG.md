## [1.0.0](https://github.com/push-to/browser-extension-sdk/compare/v0.0.17...v1.0.0) (2026-11-26)

### ⚠ BREAKING CHANGES

* the SDK talks only to push-api. It needs a push-api key
(one with no permissions) and PUSHTO_CORE_URL must be the push-api host,
https and without /v1. Existing subscribers must call
registerPushSubscription again to be registered there. Notifications sent
by the old backend are still shown but no longer tracked. Timed
auto-dismiss reports no event. Click targets must be http or https, so
links to the extension's own pages no longer open.

### Features

* register and report through push-api instead of the old proxy ([115377f](https://github.com/push-to/browser-extension-sdk/commit/115377fea9238ed052d391e81bcc08fff62598bf))
* register in one call and support verified user ids ([068c426](https://github.com/push-to/browser-extension-sdk/commit/068c426e5d3530d7f348ac3d329143106d2e6e5e))

### Bug Fixes

* **review:** address PR [#6](https://github.com/push-to/browser-extension-sdk/issues/6) review — same-tag replacement, registration order, base URL and state edge cases ([0fdde80](https://github.com/push-to/browser-extension-sdk/commit/0fdde80ed1c8c7492be76d5ff861952ba16c9140))

## [0.0.17](https://github.com/push-to/browser-extension-sdk/compare/v0.0.16...v0.0.17) (2026-07-10)

### Bug Fixes

* add repository metadata required by npm provenance validation ([9ec3e0f](https://github.com/push-to/browser-extension-sdk/commit/9ec3e0f10c08d4a1b6c831f87bcf173c6728734e))

## [0.0.16](https://github.com/push-to/browser-extension-sdk/compare/v0.0.15...v0.0.16) (2026-07-10)

### Bug Fixes

* survive MV3 service-worker termination — durable state, alarms, correct tracking ([9171315](https://github.com/push-to/browser-extension-sdk/commit/91713153100c4497f2047d25610793f824b9554d))

## [0.0.15](https://github.com/push-to/browser-extension-sdk/compare/v0.0.14...v0.0.15) (2025-11-05)

### Bug Fixes

* the way it is getting the extension URL ([5752f8a](https://github.com/push-to/browser-extension-sdk/commit/5752f8ad28582b27e49ded73b5af44213be3f1bf))

## [0.0.14](https://github.com/push-to/browser-extension-sdk/compare/v0.0.13...v0.0.14) (2025-10-25)

### Bug Fixes

* publish workflow ([1030e3d](https://github.com/push-to/browser-extension-sdk/commit/1030e3d484f9895c9f5715d8d8249dbeaec36307))
* publish workflow ([0e67aff](https://github.com/push-to/browser-extension-sdk/commit/0e67aff426dae409333d935e5bd454b217f894bf))
* publish workflow ([876644c](https://github.com/push-to/browser-extension-sdk/commit/876644c338cbfc6be78537f8dee192d87665bcec))
* publish workflow ([8a4d68e](https://github.com/push-to/browser-extension-sdk/commit/8a4d68e1fa27cfc99b8a210e724539cd648458b5))
* publish workflow ([64a2afd](https://github.com/push-to/browser-extension-sdk/commit/64a2afd953584d5c5086260b6b7e45ff4d256e6f))
* publish workflow ([19333c0](https://github.com/push-to/browser-extension-sdk/commit/19333c0fa17517da8df1ae0121ca32c9c2c34fec))
* publish workflow ([52e1d0c](https://github.com/push-to/browser-extension-sdk/commit/52e1d0c889c0cd9122ee60a1dc5d1ce1469014ec))
* publish workflow ([cc16766](https://github.com/push-to/browser-extension-sdk/commit/cc1676662eb872327dd91f822b64011faf2a80e5))
