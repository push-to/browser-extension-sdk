export { PushNotifications } from './lib/pushto-chrome-extension';
export { PushToApiError } from './lib/api-client';
// Also at `@push-to/chrome-extension/page`, which is the import for a popup
// or options page: that entry holds nothing but this function.
export { requestNotificationPermission } from './page';
export type {
  FeedbackEvent,
  FeedbackEventType,
  LegacyPushPayload,
  NotificationAutoDismiss,
  NotificationBadge,
  NotificationDisplayData,
  PushApiPayload,
  PushPayload,
  PushState,
  PushSubscriptionOptions,
  RegistrationResult,
  RegistrationStatus,
  User,
} from './lib/types';
