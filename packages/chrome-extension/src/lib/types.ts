export interface PushSubscriptionOptions {
  apiKey: string;
  defaultNotificationIcon?: string;
}

// interface PushNotificationBadge {
//   text: string;
//   color: string;
// }

export interface PushNotificationData {
  title: string;
  options: {
    body: string;
    icon: string;
    data: {
      autoDismissOptions: {
        behavior: string;
        dismissTimeMS: number;
      };
      correlationId: string;
    };
  };
}
