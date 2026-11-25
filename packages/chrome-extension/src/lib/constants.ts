/**
 * Build-time default host of push-api, without the `/v1` suffix (the SDK
 * appends it). Injected by tsup; overridable at runtime with the `apiBaseUrl`
 * constructor option.
 */
export const CORE_URL: string | undefined = process.env.PUSHTO_CORE_URL;

/** Injected by tsup from package.json; the fallback is for unbuilt sources. */
export const SDK_VERSION: string =
  process.env.PUSHTO_SDK_VERSION ?? '0.0.0-dev';

export const API_VERSION_PATH = '/v1';
