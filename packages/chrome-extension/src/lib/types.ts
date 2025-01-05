export interface PushSubscriptionOptions {
  apiKey: string;
  defaultNotificationIcon?: string;
}

interface PushNotificationBadge {
  text: string;
  color: string;
}

export interface AutoDismissOptions {
  behavior: string;
  dismissTimeMS: number;
}

export interface PushNotificationOptions {
  body: string;
  icon: string;
  contextMessage?: string;
  data: {
    autoDismissOptions: AutoDismissOptions;
    correlationId: string;
    badge?: PushNotificationBadge;
    link?: string;
  };
}

export interface PushNotificationData {
  title: string;
  options: PushNotificationOptions;
}

export enum PushNotificationStatus {
  CLICKED = 'clicked',
  DELIVERED = 'delivered',
  CLOSED = 'closed',
  AUTO_DISMISSED = 'auto-dismissed',
}
