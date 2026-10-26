#import "../native/macos.m"
#include <assert.h>
@interface FixtureDelegate : NSObject <NSWindowDelegate>
@property int resized;
@end
@implementation FixtureDelegate
- (void)windowDidResize:(NSNotification *)notification { self.resized++; }
@end
int main(void) {
  @autoreleasepool {
    [NSApplication sharedApplication];
    [NSApp finishLaunching];
    NSWindow *fixture = [[NSWindow alloc] initWithContentRect:NSMakeRect(20,20,680,410) styleMask:NSWindowStyleMaskTitled|NSWindowStyleMaskClosable|NSWindowStyleMaskResizable backing:NSBackingStoreBuffered defer:NO];
    FixtureDelegate *original = [FixtureDelegate new]; fixture.delegate = original;
    assert(rieul_macos_init(NULL) == 1);
    assert(status != nil && menu.numberOfItems == 3);
    for (int i=0;i<5;i++) {
      assert(rieul_macos_show(1)); assert(rieul_macos_visible());
      assert(rieul_macos_close()); assert(!rieul_macos_visible());
      assert(rieul_macos_take_events() & RieulClose);
    }
    assert([fixture.delegate respondsToSelector:@selector(windowDidResize:)]);
    [fixture.delegate windowDidResize:[NSNotification notificationWithName:NSWindowDidResizeNotification object:fixture]];
    assert(original.resized == 1);
    [menu performActionForItemAtIndex:0]; assert(rieul_macos_take_events() & RieulInfo);
    [menu performActionForItemAtIndex:2]; assert(rieul_macos_take_events() & RieulQuit);
    assert(rieul_macos_notify("fixture", "no new permission requested") == 0);
    assert(rieul_macos_destroy()); assert(fixture.delegate == original); assert(status == nil);
    [fixture close];
    puts("AppKit bridge lifecycle/forwarding/status actions/fallback/disposal passed; OS user-selection and notification display unverified");
  }
  return 0;
}
