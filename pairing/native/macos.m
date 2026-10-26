// Rieul-owned AppKit bridge source. Not enabled until built and QA'd on macOS.
// No GPUI/Zed source is copied. All entry points require the AppKit main thread.
#import <Cocoa/Cocoa.h>
#include <stdatomic.h>
#include <stdint.h>

enum { RieulClose = 1, RieulOpen = 2, RieulInfo = 4, RieulQuit = 8 };
static atomic_uint events;
static NSWindow *window;
static NSStatusItem *status;
static NSMenu *menu;
static NSApplicationActivationPolicy previousPolicy;
static BOOL changedPolicy;

@interface RieulWindowDelegate : NSObject <NSWindowDelegate>
@property(nonatomic, weak) id original;
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
    [window orderOut:nil];
    atomic_store(&events, 0);
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
int32_t rieul_macos_destroy(void) {
  @autoreleasepool {
    if (![NSThread isMainThread]) return 0;
    if (window.delegate == delegate) window.delegate = delegate.original;
    if (status) [NSStatusBar.systemStatusBar removeStatusItem:status];
    if (changedPolicy) [NSApp setActivationPolicy:previousPolicy];
    status = nil; menu = nil; target = nil; delegate = nil; window = nil;
    changedPolicy = NO; atomic_store(&events, 0);
    return 1;
  }
}
