// src/lib/constants.ts
var CORE_URL = "https://api.pushto.ai";

// src/lib/push-notification-storage.ts
var PushNotificationStorage = class {
  static async getAnonymousId() {
    let { pt_anonymousId } = await chrome.storage.local.get(
      "pt_anonymousId"
    );
    if (pt_anonymousId === void 0) {
      pt_anonymousId = self.crypto.randomUUID();
      chrome.storage.local.set({ pt_anonymousId });
    }
    return pt_anonymousId;
  }
};

// src/lib/register-subscription.ts
var RegisterSubscription = class {
  constructor(apiKey) {
    this.apiKey = apiKey;
    this.registerUrl = CORE_URL + "/subscriptions";
    this.vapidKeysUrl = CORE_URL + "/vapid-keys";
  }
  async registerPushSubscription(currentUrl, user) {
    if (this.registerUrl === void 0) {
      throw new Error("registerUrl is not set");
    }
    if (typeof self === "undefined" || !self.registration) {
      throw new Error(
        "Service Worker registration is not available. Ensure this code is running in a Service Worker context and the Service Worker is properly registered."
      );
    }
    const localRegistration = self.registration;
    const registration = localRegistration;
    const subscription = await this.subscribePush(registration);
    const anonymousId = await PushNotificationStorage.getAnonymousId();
    let response;
    try {
      response = await fetch(this.registerUrl, {
        method: "POST",
        body: JSON.stringify({
          anonymousId,
          browserLanguage: navigator.language,
          subscription,
          context: {
            url: currentUrl
          },
          user
        }),
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`
        }
      });
    } catch (error) {
      throw new Error(
        `Failed to register push subscription at ${this.registerUrl}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
    if (!response.ok) {
      const errorText = await response.text().catch(() => "Unable to read error response");
      throw new Error(
        `Failed to register push subscription: HTTP ${response.status} ${response.statusText}. ${errorText}`
      );
    }
  }
  async subscribePush(registration) {
    let response;
    try {
      response = await fetch(this.vapidKeysUrl, {
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`
        }
      });
    } catch (error) {
      throw new Error(
        `Failed to fetch VAPID keys from ${this.vapidKeysUrl}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
    if (!response.ok) {
      const errorText = await response.text().catch(() => "Unable to read error response");
      throw new Error(
        `Failed to fetch VAPID keys: HTTP ${response.status} ${response.statusText}. ${errorText}`
      );
    }
    let data;
    try {
      data = await response.json();
    } catch (error) {
      throw new Error(
        `Failed to parse VAPID keys response as JSON: ${error instanceof Error ? error.message : String(error)}`
      );
    }
    const publicVapidKey = data.publicVapidKey;
    if (publicVapidKey === void 0) {
      throw new Error("PUBLIC_VAPID_KEY is not set in API response");
    }
    const subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: this.urlBase64ToUint8Array(publicVapidKey)
    });
    return subscription;
  }
  urlBase64ToUint8Array(b64) {
    const padding = "=".repeat((4 - b64.length % 4) % 4);
    const base64 = (b64 + padding).replace(/\-/g, "+").replace(/_/g, "/");
    const rawData = globalThis.atob(base64);
    const outputArray = new Uint8Array(rawData.length);
    for (let i = 0; i < rawData.length; ++i) {
      outputArray[i] = rawData.charCodeAt(i);
    }
    return outputArray;
  }
};

// src/lib/notifications-state.ts
var _NotificationsState = class _NotificationsState {
  constructor() {
  }
  static get instance() {
    if (!this.notificationsState) {
      this.notificationsState = new _NotificationsState();
    }
    return this.notificationsState;
  }
  async readAll() {
    const stored = await chrome.storage.local.get(
      _NotificationsState.STORAGE_KEY
    );
    return stored[_NotificationsState.STORAGE_KEY] ?? {};
  }
  async writeAll(notifications) {
    await chrome.storage.local.set({
      [_NotificationsState.STORAGE_KEY]: notifications
    });
  }
  async addNotification(notificationId, notification) {
    const notifications = await this.readAll();
    notifications[notificationId] = notification;
    await this.writeAll(notifications);
  }
  async removeNotification(notificationId) {
    const notifications = await this.readAll();
    if (notificationId in notifications) {
      delete notifications[notificationId];
      await this.writeAll(notifications);
    }
  }
  async getNotifications() {
    return this.readAll();
  }
  async getNotification(notificationId) {
    const notifications = await this.readAll();
    return notifications[notificationId];
  }
  async removeNotificationsByTag(apiKey, tag) {
    const notifications = await this.readAll();
    let changed = false;
    for (const [notificationId, notification] of Object.entries(
      notifications
    )) {
      if (notification.options.data.tag === tag) {
        delete notifications[notificationId];
        changed = true;
        PushNotificationEvents.getInstance(apiKey).handleAutoDismissed(
          notificationId
        );
      }
    }
    if (changed) {
      await this.writeAll(notifications);
    }
  }
};
_NotificationsState.STORAGE_KEY = "pt_notifications";
var NotificationsState = _NotificationsState;

// src/lib/push-notification-events.ts
var PushNotificationEvents = class _PushNotificationEvents {
  constructor(apiKey) {
    this.apiKey = apiKey;
    this.trackNotificationUrl = CORE_URL + "/notifications/track";
  }
  static getInstance(apiKey) {
    if (!this.pushNotificationEvents) {
      this.pushNotificationEvents = new _PushNotificationEvents(apiKey);
      this.pushNotificationEvents.listenForPushNotificationEvents();
    }
    return this.pushNotificationEvents;
  }
  handleDisplayed(notificationId) {
    this.sendTrackNotificationEvent(
      notificationId,
      "delivered" /* DELIVERED */
    );
  }
  handleAutoDismissed(notificationId) {
    this.sendTrackNotificationEvent(
      notificationId,
      "auto-dismissed" /* AUTO_DISMISSED */
    );
    chrome.notifications.clear(notificationId);
  }
  async handleNotificationClick(notificationId) {
    const notification = await NotificationsState.instance.getNotification(notificationId);
    this.sendTrackNotificationEvent(
      notificationId,
      "clicked" /* CLICKED */
    );
    chrome.notifications.clear(notificationId);
    if (notification?.options?.data?.link) {
      chrome.tabs.create({ url: notification.options.data.link });
    }
    if (notification?.options?.data?.badge) {
      chrome.action.setBadgeText({ text: "" });
    }
  }
  async handleNotificationClose(notificationId, _byUser) {
    this.sendTrackNotificationEvent(
      notificationId,
      "closed" /* CLOSED */
    );
    await NotificationsState.instance.removeNotification(notificationId);
  }
  listenForPushNotificationEvents() {
    chrome.notifications.onClicked.addListener(
      this.handleNotificationClick.bind(this)
    );
    chrome.notifications.onClosed.addListener(
      this.handleNotificationClose.bind(this)
    );
  }
  async sendTrackNotificationEvent(notificationId, status) {
    await fetch(this.trackNotificationUrl, {
      method: "POST",
      body: JSON.stringify({ correlationId: notificationId, status }),
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`
      }
    });
  }
};

// src/lib/dismiss.ts
var ALARM_PREFIX = "pt-dismiss:";
var MIN_ALARM_DELAY_MS = 3e4;
var Dismiss = class _Dismiss {
  constructor() {
    this.shortTimers = /* @__PURE__ */ new Map();
    this.listenersRegistered = false;
  }
  static get instance() {
    if (!this.dismiss) {
      this.dismiss = new _Dismiss();
    }
    return this.dismiss;
  }
  /**
   * Register the top-level `onAlarm`/`onClosed` listeners. Called on every SW
   * startup so a worker re-woken by an alarm it never scheduled still handles
   * it. Idempotent — the listeners are added at most once per worker instance.
   */
  registerListeners(apiKey) {
    this.apiKey = apiKey;
    if (this.listenersRegistered) {
      return;
    }
    this.listenersRegistered = true;
    chrome.alarms.onAlarm.addListener((alarm) => {
      if (!alarm.name.startsWith(ALARM_PREFIX)) {
        return;
      }
      const correlationId = alarm.name.slice(ALARM_PREFIX.length);
      void this.fireDismissIfPresent(correlationId);
    });
    chrome.notifications.onClosed.addListener((notificationId) => {
      void this.handleNotificationClose(notificationId);
    });
  }
  async handleTimedAutoDismiss(apiKey, correlationId, autoDismissOptions) {
    if (autoDismissOptions?.behavior !== "timed") {
      return;
    }
    this.apiKey = apiKey;
    const delayMs = autoDismissOptions.dismissTimeMS;
    await chrome.alarms.create(ALARM_PREFIX + correlationId, {
      delayInMinutes: Math.max(delayMs, MIN_ALARM_DELAY_MS) / 6e4
    });
    if (delayMs < MIN_ALARM_DELAY_MS) {
      const timer = setTimeout(() => {
        this.shortTimers.delete(correlationId);
        void this.fireDismissIfPresent(correlationId);
      }, delayMs);
      this.shortTimers.set(correlationId, timer);
    }
  }
  async handleNotificationClose(correlationId) {
    await chrome.alarms.clear(ALARM_PREFIX + correlationId);
    const timer = this.shortTimers.get(correlationId);
    if (timer) {
      clearTimeout(timer);
      this.shortTimers.delete(correlationId);
    }
  }
  /**
   * Dismiss the notification only if it is still on screen. The existence check
   * makes this idempotent: whichever of the setTimeout or the alarm fires first
   * dismisses and clears the notification; a later firing finds it gone and
   * no-ops. Scheduling artifacts are always cleaned up.
   */
  async fireDismissIfPresent(correlationId) {
    const isPresent = (await this.getActiveNotificationIds()).includes(
      correlationId
    );
    await this.handleNotificationClose(correlationId);
    if (isPresent && this.apiKey) {
      PushNotificationEvents.getInstance(this.apiKey).handleAutoDismissed(
        correlationId
      );
    }
  }
  async getActiveNotificationIds() {
    return new Promise((resolve) => {
      chrome.notifications.getAll((notificationsObj) => {
        resolve(Object.keys(notificationsObj ?? {}));
      });
    });
  }
};

// src/lib/receive-notification.ts
var ReceiveNotification = class _ReceiveNotification {
  constructor(apiKey, options) {
    this.apiKey = apiKey;
    this.defaultNotificationIcon = options.defaultNotificationIcon;
  }
  static initialize(apiKey, options) {
    if (!this.instance || this.instance.defaultNotificationIcon !== options.defaultNotificationIcon) {
      if (this.instance) {
        this.instance.removeListener();
      }
      this.instance = new _ReceiveNotification(apiKey, options);
      this.instance.listenForPushNotifications();
      this.instance.listenForAction();
      Dismiss.instance.registerListeners(apiKey);
      PushNotificationEvents.getInstance(apiKey);
    }
    return this.instance;
  }
  listenForAction() {
    chrome.action.onClicked.addListener(() => {
      chrome.action.setBadgeText({ text: "" });
    });
  }
  handlePushNotification(event) {
    if (event.data === null) {
      return;
    }
    event.waitUntil(this.showNotification(event.data.json()));
  }
  removeListener() {
    self.removeEventListener("push", this.handlePushNotification);
  }
  listenForPushNotifications() {
    self.addEventListener("push", this.handlePushNotification.bind(this));
  }
  async showNotification(data) {
    const title = data.title;
    const body = data.options.body;
    const icon = this.defaultNotificationIcon ?? data.options.icon;
    const options = {
      title,
      message: body,
      priority: 1,
      type: "basic",
      isClickable: true,
      iconUrl: icon
    };
    if (data.options.contextMessage) {
      options.contextMessage = data.options.contextMessage;
    }
    if (data.options.data?.autoDismissOptions?.behavior === "device_default") {
      options.requireInteraction = true;
    }
    if (data.options.data?.tag) {
      await NotificationsState.instance.removeNotificationsByTag(
        this.apiKey,
        data.options.data.tag
      );
    }
    chrome.notifications.create(data.options.data.correlationId, options);
    await NotificationsState.instance.addNotification(
      data.options.data.correlationId,
      data
    );
    PushNotificationEvents.getInstance(this.apiKey).handleDisplayed(
      data.options.data.correlationId
    );
    if (data.options?.data?.autoDismissOptions?.behavior === "timed") {
      Dismiss.instance.handleTimedAutoDismiss(
        this.apiKey,
        data.options.data.correlationId,
        data.options.data.autoDismissOptions
      );
    }
    if (data.options.data.badge) {
      chrome.action.setBadgeText({ text: data.options.data.badge.text });
      chrome.action.setBadgeBackgroundColor({
        color: data.options.data.badge.color
      });
    }
  }
};

// src/lib/pushto-chrome-extension.ts
var PushNotifications = class {
  constructor(options) {
    if (typeof self === "undefined" || !("ServiceWorkerGlobalScope" in globalThis)) {
      throw new Error(
        "PushNotifications must be initialized in a Service Worker context. Ensure this code is running in your extension's service worker file."
      );
    }
    this.apiKey = options.apiKey;
    ReceiveNotification.initialize(this.apiKey, options);
  }
  async registerPushSubscription(user) {
    const registerSubscription = new RegisterSubscription(this.apiKey);
    let currentUrl;
    try {
      currentUrl = this.getExtensionUrl();
    } catch (error) {
      throw new Error(
        `Failed to capture current URL from Service Worker fetch event: ${error instanceof Error ? error.message : String(error)}. Make sure the Service Worker is properly installed and activated.`
      );
    }
    await registerSubscription.registerPushSubscription(currentUrl, user);
  }
  getExtensionUrl(path = "/") {
    return chrome.runtime.getURL(path);
  }
};

export { PushNotifications };
//# sourceMappingURL=index.js.map
//# sourceMappingURL=index.js.map