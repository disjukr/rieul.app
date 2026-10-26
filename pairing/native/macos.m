// Rieul-owned AppKit bridge. No system permissions or service changes.
// No GPUI/Zed source is copied. All entry points require the AppKit main thread.
#import <Cocoa/Cocoa.h>
#import <UserNotifications/UserNotifications.h>
#include <stdatomic.h>
#include <stdint.h>

enum { RieulClose = 1, RieulOpen = 2, RieulInfo = 4, RieulQuit = 8 };
static atomic_uint events;
static NSWindow *window;
static NSStatusItem *status;
static NSMenu *menu;
static NSApplicationActivationPolicy previousPolicy;
static BOOL changedPolicy;
static atomic_int notificationAuthorization;
static atomic_uint notificationEpoch;
static atomic_uint notificationToken;
static atomic_int notificationResult;
static UNUserNotificationCenter *notificationCenter;
static NSString *notificationIdentifier;
static __weak id<UNUserNotificationCenterDelegate> originalNotificationDelegate;
@interface RieulNotificationTarget : NSObject <UNUserNotificationCenterDelegate>
@end
@implementation RieulNotificationTarget
- (void)userNotificationCenter:(UNUserNotificationCenter *)center willPresentNotification:(UNNotification *)notification withCompletionHandler:(void (^)(UNNotificationPresentationOptions))completion {
  completion(UNNotificationPresentationOptionBanner | UNNotificationPresentationOptionSound);
}
- (void)userNotificationCenter:(UNUserNotificationCenter *)center didReceiveNotificationResponse:(UNNotificationResponse *)response withCompletionHandler:(void (^)(void))completion {
  atomic_fetch_or(&events, RieulOpen); completion();
}
@end
static RieulNotificationTarget *notificationTarget;

@interface RieulWindowDelegate : NSObject <NSWindowDelegate>
@property(nonatomic, strong) id original;
@end
@implementation RieulWindowDelegate
- (BOOL)windowShouldClose:(NSWindow *)sender {
  [sender orderOut:nil];
  atomic_fetch_or(&events, RieulClose);
  return NO;
}
- (BOOL)respondsToSelector:(SEL)selector {
  return [super respondsToSelector:selector] || [self.original respondsToSelector:selector];
}
- (id)forwardingTargetForSelector:(SEL)selector {
  if ([self.original respondsToSelector:selector]) return self.original;
  return [super forwardingTargetForSelector:selector];
}
@end
static RieulWindowDelegate *delegate;

@interface RieulApplicationDelegate : NSObject <NSApplicationDelegate>
@property(nonatomic, strong) id original;
@end
@implementation RieulApplicationDelegate
- (BOOL)applicationShouldHandleReopen:(NSApplication *)sender hasVisibleWindows:(BOOL)visible {
  if ([self.original respondsToSelector:_cmd])
    [self.original applicationShouldHandleReopen:sender hasVisibleWindows:visible];
  atomic_fetch_or(&events, RieulOpen);
  return NO; // The host activates its existing profile window.
}
- (BOOL)respondsToSelector:(SEL)selector {
  return [super respondsToSelector:selector] || [self.original respondsToSelector:selector];
}
- (id)forwardingTargetForSelector:(SEL)selector {
  if ([self.original respondsToSelector:selector]) return self.original;
  return [super forwardingTargetForSelector:selector];
}
@end
static RieulApplicationDelegate *applicationDelegate;

@interface RieulStatusTarget : NSObject
- (void)activate:(id)sender;
- (void)info:(id)sender;
- (void)quit:(id)sender;
@end
@implementation RieulStatusTarget
- (void)activate:(id)sender {
  NSEventType type = NSApp.currentEvent.type;
  if (type == NSEventTypeRightMouseUp) {
    // Normal AppKit popup; target actions enqueue events for the JS poller.
    [menu popUpMenuPositioningItem:nil atLocation:NSMakePoint(0, 0) inView:status.button];
  } else {
    atomic_fetch_or(&events, RieulOpen);
  }
}
- (void)info:(id)sender { atomic_fetch_or(&events, RieulInfo); }
- (void)quit:(id)sender { atomic_fetch_or(&events, RieulQuit); }
@end
static RieulStatusTarget *target;

int32_t rieul_macos_init(const char *iconPath) {
  @autoreleasepool {
    if (![NSThread isMainThread]) return -2;
    if (window || status) return -3;
    for (NSWindow *candidate in NSApp.windows) {
      NSRect bounds = candidate.contentLayoutRect;
      if (bounds.size.width >= 300 && bounds.size.height >= 200) { window = candidate; break; }
    }
    if (!window) return 0;
    delegate = [RieulWindowDelegate new];
    delegate.original = window.delegate;
    window.delegate = delegate;
    target = [RieulStatusTarget new];
    status = [NSStatusBar.systemStatusBar statusItemWithLength:NSVariableStatusItemLength];
    if (!status || !status.button) {
      window.delegate = delegate.original;
      if (status) [NSStatusBar.systemStatusBar removeStatusItem:status];
      delegate = nil; target = nil; status = nil; window = nil;
      return -4;
    }
    status.button.title = @"Rieul";
    status.button.toolTip = @"Rieul";
    if (iconPath) {
      NSImage *image = [[NSImage alloc] initWithContentsOfFile:[NSString stringWithUTF8String:iconPath]];
      if (image) { image.size = NSMakeSize(18, 18); image.template = YES; status.button.image = image; status.button.title = @""; }
    }
    status.button.target = target;
    status.button.action = @selector(activate:);
    [status.button sendActionOn:NSEventMaskLeftMouseUp | NSEventMaskRightMouseUp];
    menu = [[NSMenu alloc] initWithTitle:@"Rieul"];
    NSMenuItem *info = [[NSMenuItem alloc] initWithTitle:@"Daemon info" action:@selector(info:) keyEquivalent:@""];
    info.target = target; [menu addItem:info];
    [menu addItem:NSMenuItem.separatorItem];
    NSMenuItem *quit = [[NSMenuItem alloc] initWithTitle:@"Quit" action:@selector(quit:) keyEquivalent:@""];
    quit.target = target; [menu addItem:quit];
    previousPolicy = NSApp.activationPolicy;
    changedPolicy = [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];
    applicationDelegate = [RieulApplicationDelegate new];
    applicationDelegate.original = NSApp.delegate;
    NSApp.delegate = applicationDelegate;
    [window orderOut:nil];
    atomic_store(&events, 0);
    // Query an existing authorization only. Never request a new permission.
    if (NSBundle.mainBundle.bundleIdentifier && [NSBundle.mainBundle.bundleURL.pathExtension isEqualToString:@"app"]) {
      notificationCenter = UNUserNotificationCenter.currentNotificationCenter;
      notificationIdentifier = [@"rieul-pairing-" stringByAppendingString:NSUUID.UUID.UUIDString];
      originalNotificationDelegate = notificationCenter.delegate;
      notificationTarget = [RieulNotificationTarget new];
      notificationCenter.delegate = notificationTarget;
      uint32_t epoch = atomic_fetch_add(&notificationEpoch, 1) + 1;
      [notificationCenter getNotificationSettingsWithCompletionHandler:^(UNNotificationSettings *settings) {
        BOOL allowed = settings.authorizationStatus == UNAuthorizationStatusAuthorized || settings.authorizationStatus == UNAuthorizationStatusProvisional;
        if (atomic_load(&notificationEpoch) == epoch)
          atomic_store(&notificationAuthorization, allowed ? 1 : -1);
      }];
    }
    return 1;
  }
}
uint32_t rieul_macos_take_events(void) { return atomic_exchange(&events, 0); }
int32_t rieul_macos_show(int32_t visible) {
  if (![NSThread isMainThread] || !window) return 0;
  if (visible) { [NSApp activateIgnoringOtherApps:YES]; [window makeKeyAndOrderFront:nil]; }
  else [window orderOut:nil];
  return 1;
}
int32_t rieul_macos_visible(void) {
  return [NSThread isMainThread] && window && window.visible;
}
int32_t rieul_macos_close(void) {
  if (![NSThread isMainThread] || !window) return 0;
  [window performClose:nil]; return 1;
}
uint32_t rieul_macos_notify(const char *title, const char *body) {
  if (![NSThread isMainThread] || !notificationCenter || atomic_load(&notificationAuthorization) != 1) return 0;
  uint32_t token = atomic_fetch_add(&notificationToken, 1) + 1;
  atomic_store(&notificationResult, 0);
  UNMutableNotificationContent *content = [UNMutableNotificationContent new];
  content.title = [NSString stringWithUTF8String:title]; content.body = [NSString stringWithUTF8String:body];
  UNNotificationRequest *request = [UNNotificationRequest requestWithIdentifier:notificationIdentifier content:content trigger:nil];
  [notificationCenter addNotificationRequest:request withCompletionHandler:^(NSError *error) {
    if (atomic_load(&notificationToken) == token) atomic_store(&notificationResult, error ? -1 : 1);
  }];
  return token;
}
int32_t rieul_macos_notification_result(uint32_t token) {
  if (token != atomic_load(&notificationToken)) return -2;
  return atomic_load(&notificationResult);
}
int32_t rieul_macos_destroy(void) {
  @autoreleasepool {
    if (![NSThread isMainThread]) return 0;
    if (window.delegate == delegate) window.delegate = delegate.original;
    if (NSApp.delegate == applicationDelegate) NSApp.delegate = applicationDelegate.original;
    applicationDelegate = nil;
    if (status) [NSStatusBar.systemStatusBar removeStatusItem:status];
    if (notificationCenter.delegate == notificationTarget) notificationCenter.delegate = originalNotificationDelegate;
    if (notificationIdentifier) {
      [notificationCenter removeDeliveredNotificationsWithIdentifiers:@[notificationIdentifier]];
      [notificationCenter removePendingNotificationRequestsWithIdentifiers:@[notificationIdentifier]];
    }
    notificationIdentifier = nil;
    atomic_fetch_add(&notificationEpoch, 1);
    atomic_fetch_add(&notificationToken, 1);
    notificationCenter = nil; notificationTarget = nil; atomic_store(&notificationAuthorization, 0);
    if (changedPolicy) [NSApp setActivationPolicy:previousPolicy];
    status = nil; menu = nil; target = nil; delegate = nil; window = nil;
    changedPolicy = NO; atomic_store(&events, 0);
    return 1;
  }
}
