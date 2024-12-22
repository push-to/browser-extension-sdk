export interface PushSubscriptionOptions {
  apiKey: string;
  defaultNotificationIcon?: string;
}

interface PushNotificationBadge {
  text: string;
  color: string;
}

export interface PushNotificationData {
  title: string;
  body: string;
  icon: string;
  badge?: PushNotificationBadge;
}
