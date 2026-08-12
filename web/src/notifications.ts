// web/src/notifications.ts
//
// Thin wrapper over the browser Notification API. No service worker, no push
// subscription -- these only fire while this tab is open (backgrounded is
// fine, fully closed is not), which is what "browser notifications, no email
// hooks" means here.

export type NotificationPermissionState = 'unsupported' | 'default' | 'granted' | 'denied'

export function getPermissionState(): NotificationPermissionState {
  if (!('Notification' in window)) return 'unsupported'
  return Notification.permission
}

/** Must be called from a user gesture (e.g. a button click) -- browsers ignore/reject unprompted requests. */
export async function requestPermission(): Promise<NotificationPermissionState> {
  if (!('Notification' in window)) return 'unsupported'
  const result = await Notification.requestPermission()
  return result
}

/** Fires a native browser notification if permission has been granted; a silent no-op otherwise. */
export function notify(title: string, body: string, tag?: string): void {
  if (!('Notification' in window) || Notification.permission !== 'granted') return
  new Notification(title, { body, tag })
}
