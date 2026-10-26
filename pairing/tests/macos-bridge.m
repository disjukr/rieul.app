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
    fixture.releasedWhenClosed = NO;
    fprintf(stderr, "fixture: window ready\n");
    FixtureDelegate *original = [FixtureDelegate new]; fixture.delegate = original;
    NSString *icon = [NSFileManager.defaultManager.currentDirectoryPath stringByAppendingPathComponent:@"pairing/assets/tray.png"];
    assert(rieul_macos_init(icon.UTF8String) == 1);
    assert(status.button.image != nil && status.button.image.template);
    fprintf(stderr, "fixture: bridge initialized\n");
    assert(status != nil && menu.numberOfItems == 3);
    for (int i=0;i<5;i++) {
      assert(rieul_macos_show(1)); assert(rieul_macos_visible());
      assert(rieul_macos_close()); assert(!rieul_macos_visible());
      assert(rieul_macos_take_events() & RieulClose);
    }
    assert([fixture.delegate respondsToSelector:@selector(windowDidResize:)]);
    [fixture.delegate windowDidResize:[NSNotification notificationWithName:NSWindowDidResizeNotification object:fixture]];
    assert(original.resized == 1);
    fprintf(stderr, "fixture: repeated close and delegate forwarding passed\n");
    [menu performActionForItemAtIndex:0]; assert(rieul_macos_take_events() & RieulInfo);
    [menu performActionForItemAtIndex:2]; assert(rieul_macos_take_events() & RieulQuit);
    assert(rieul_macos_notify("fixture", "no new permission requested") == 0);
    assert(rieul_macos_destroy()); assert(fixture.delegate == original); assert(status == nil);
    fprintf(stderr, "fixture: disposal passed\n");
    [fixture close];
    puts("AppKit bridge lifecycle/forwarding/status actions/fallback/disposal passed; OS user-selection and notification display unverified");
  }
  return 0;
}
