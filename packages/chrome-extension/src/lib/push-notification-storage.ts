export class PushNotificationStorage {
  public static async getAnonymousId() {
    let { pt_anonymousId } = (await chrome.storage.local.get(
      'pt_anonymousId',
    )) as {
      pt_anonymousId: string;
    };

    if (pt_anonymousId === undefined) {
      pt_anonymousId = self.crypto.randomUUID();
      chrome.storage.local.set({ pt_anonymousId });
    }

    return pt_anonymousId;
  }
}
