#import <AppKit/AppKit.h>
#import <CoreGraphics/CoreGraphics.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>
#include <pwd.h>

extern int rd_permissions(void);
extern bool rd_probe_video(uint32_t, uint32_t, uint32_t, uint32_t, uint32_t *);
extern bool rd_probe_hevc(uint32_t, uint32_t, uint32_t, uint32_t, uint32_t, char *, size_t);
typedef bool (*Spatial)(void *, const uint8_t *, size_t, const uint8_t *, size_t, size_t, size_t, uint32_t *, uint32_t *, bool *);
typedef bool (*Packet)(void *, const uint8_t *, size_t, uint64_t);
extern void *rd_capture_create(uint32_t, double, double, double, double, uint32_t, uint32_t, uint32_t, uint32_t, uint32_t, bool, bool *);
extern int rd_capture_next(void *, uint64_t, bool, bool, uint32_t, Spatial, void *, bool *, Packet, void *);
extern bool rd_capture_destroy(void *);

enum { Width = 640, Height = 480, Fps = 30, Bitrate = 2000000, PacketLimit = 10 };

typedef struct {
    uint32_t packets;
    uint64_t bytes;
    uint32_t markerChecks;
    uint32_t markerMatches;
} PacketCounts;

static bool env_is(const char *name, const char *expected) {
    const char *value = getenv(name);
    return value && strcmp(value, expected) == 0;
}

static bool hosted_fixture(void) {
#if !defined(__arm64__)
    return false;
#else
    struct passwd *user = getpwuid(geteuid());
    return geteuid() != 0 && user && strcmp(user->pw_name, "runner") == 0 &&
        env_is("HOME", "/Users/runner") &&
        env_is("GITHUB_ACTIONS", "true") &&
        env_is("RUNNER_ENVIRONMENT", "github-hosted") &&
        env_is("RUNNER_OS", "macOS") && env_is("RUNNER_ARCH", "ARM64") &&
        env_is("GITHUB_SERVER_URL", "https://github.com") &&
        env_is("GITHUB_REPOSITORY", "disjukr/rieul.app") &&
        env_is("GITHUB_REF", "refs/heads/main") &&
        env_is("GITHUB_EVENT_NAME", "workflow_dispatch") &&
        env_is("GITHUB_WORKFLOW", "Screen capture capability probe") &&
        env_is("GITHUB_WORKFLOW_REF", "disjukr/rieul.app/.github/workflows/probe-screen-fixture.yml@refs/heads/main");
#endif
}

static void report(NSDictionary *result) {
    NSData *json = [NSJSONSerialization dataWithJSONObject:result options:NSJSONWritingSortedKeys error:nil];
    if (!json) exit(70);
    fwrite(json.bytes, 1, json.length, stdout);
    fputc('\n', stdout);
    fflush(stdout);
}

static bool observe_packet(void *context, const uint8_t *data, size_t length, uint64_t timestamp) {
    (void)timestamp;
    if (!data || !length || length > 4 * 1024 * 1024) return false;
    PacketCounts *counts = context;
    counts->packets++;
    counts->bytes += length;
    return true;
}

static bool full_frame(void *context, const uint8_t *luma, size_t lumaStride, const uint8_t *chroma, size_t chromaStride, size_t width, size_t height, uint32_t *mask, uint32_t *target, bool *damaged) {
    PacketCounts *counts = context;
    counts->markerChecks++;
    if (!luma || !chroma || lumaStride < Width || chromaStride < Width || width != Width || height != Height) return false;
    static const struct { unsigned x, y, low, high; } patches[] = {
        {10, 10, 210, 255}, {90, 10, 0, 40},
        {10, 90, 0, 40}, {90, 90, 210, 255},
        {50, 10, 80, 180}, {50, 90, 80, 180},
        {40, 50, 210, 255}, {60, 50, 0, 40}
    };
    for (size_t i = 0; i < sizeof(patches) / sizeof(patches[0]); i++) {
        size_t x = width * patches[i].x / 100, y = height * patches[i].y / 100;
        for (size_t dy = 0; dy < 5; dy++) for (size_t dx = 0; dx < 5; dx++) {
            unsigned value = luma[(y + dy) * lumaStride + x + dx];
            if (value < patches[i].low || value > patches[i].high) return false;
        }
    }
    counts->markerMatches++;
    *mask = UINT32_MAX;
    *target = Bitrate;
    *damaged = true;
    return true;
}

@interface SyntheticScene : NSView
@property NSUInteger tick;
@property NSSize markerSize;
@end
@implementation SyntheticScene
- (BOOL)isFlipped { return YES; }
- (void)drawRect:(NSRect)dirtyRect {
    (void)dirtyRect;
    CGFloat w = self.markerSize.width, h = self.markerSize.height;
    [[NSColor colorWithCalibratedWhite:0.5 alpha:1] setFill];
    NSRectFill(self.bounds);
    [NSColor.whiteColor setFill];
    NSRectFill(NSMakeRect(w * .02, h * .02, w * .16, h * .16));
    NSRectFill(NSMakeRect(w * .82, h * .82, w * .16, h * .16));
    NSRectFill(NSMakeRect(w * .32, h * .42, w * .16, h * .16));
    [NSColor.blackColor setFill];
    NSRectFill(NSMakeRect(w * .82, h * .02, w * .16, h * .16));
    NSRectFill(NSMakeRect(w * .02, h * .82, w * .16, h * .16));
    NSRectFill(NSMakeRect(w * .52, h * .42, w * .16, h * .16));
    NSString *label = [NSString stringWithFormat:@"Rieul synthetic fixture %lu", (unsigned long)self.tick];
    [label drawAtPoint:NSMakePoint(w * .3, h * .26) withAttributes:@{
        NSFontAttributeName: [NSFont monospacedSystemFontOfSize:w / 50 weight:NSFontWeightMedium],
        NSForegroundColorAttributeName: NSColor.whiteColor
    }];
    [[NSColor colorWithCalibratedRed:0.2 green:0.8 blue:0.4 alpha:1] setFill];
    NSRectFill(NSMakeRect(w * (.3 + (self.tick % 100) / 1000.0), h * .7, w * .05, h * .05));
}
@end

int main(void) {
    @autoreleasepool {
        if (!hosted_fixture()) {
            report(@{@"status": @"refused", @"reason": @"not_expected_manual_hosted_arm64_fixture"});
            return 64;
        }
        int permissions = rd_permissions();
        uint32_t h264Codec = 0;
        char hevcCodec[128] = {0};
        bool h264 = rd_probe_video(Width, Height, Fps, Bitrate, &h264Codec);
        bool hevc = rd_probe_hevc(Width, Height, Fps, Bitrate, 0, hevcCodec, sizeof(hevcCodec));
        NSString *selectedCodec = hevc ? [NSString stringWithUTF8String:hevcCodec] : [NSString stringWithFormat:@"avc1.%06x", h264Codec];
        NSMutableDictionary *result = [@{
            @"scope": @"hosted_synthetic_capture_capability_not_end_to_end_latency",
            @"os": NSProcessInfo.processInfo.operatingSystemVersionString,
            @"arch": @"arm64",
            @"capturePermission": @((permissions & 1) != 0),
            @"inputPermission": @((permissions & 2) != 0),
            @"h264Hardware": @(h264), @"hevcHardware": @(hevc),
            @"width": @(Width), @"height": @(Height), @"fpsTarget": @(Fps)
        } mutableCopy];
        if (!(permissions & 1) || (!h264 && !hevc)) {
            result[@"status"] = @"skipped";
            result[@"reason"] = !(permissions & 1) ? @"capture_permission_or_console_unavailable" : @"required_hardware_encoder_unavailable";
            report(result);
            return 0;
        }
        [NSApplication sharedApplication];
        [NSApp setActivationPolicy:NSApplicationActivationPolicyRegular];
        [NSApp finishLaunching];
        NSScreen *screen = NSScreen.mainScreen;
        if (!screen) {
            result[@"status"] = @"skipped";
            result[@"reason"] = @"no_runner_display";
            report(result);
            return 0;
        }
        CGDirectDisplayID display = [screen.deviceDescription[@"NSScreenNumber"] unsignedIntValue];
        if (CGDisplayPixelsWide(display) < Width || CGDisplayPixelsHigh(display) < Height) {
            result[@"status"] = @"skipped";
            result[@"reason"] = @"runner_display_smaller_than_fixture";
            report(result);
            return 0;
        }
        double scale = CGDisplayPixelsWide(display) / CGDisplayBounds(display).size.width;
        NSWindow *window = [[NSWindow alloc] initWithContentRect:screen.frame styleMask:NSWindowStyleMaskBorderless backing:NSBackingStoreBuffered defer:NO];
        window.releasedWhenClosed = NO;
        window.level = NSScreenSaverWindowLevel;
        window.opaque = YES;
        SyntheticScene *scene = [[SyntheticScene alloc] initWithFrame:NSMakeRect(0, 0, screen.frame.size.width, screen.frame.size.height)];
        scene.markerSize = NSMakeSize(Width / scale, Height / scale);
        window.contentView = scene;
        [window setFrame:screen.frame display:YES];
        [window makeKeyAndOrderFront:nil];
        [NSApp activateIgnoringOtherApps:YES];
        [window display];
        NSTimer *timer = [NSTimer scheduledTimerWithTimeInterval:1.0 / Fps repeats:YES block:^(NSTimer *unused) {
            (void)unused;
            scene.tick++;
            [scene setNeedsDisplay:YES];
        }];
        dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 15 * NSEC_PER_SEC), dispatch_get_main_queue(), ^{
            report(@{@"status": @"failed", @"reason": @"bounded_probe_timeout"});
            exit(75);
        });
        dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 250 * NSEC_PER_MSEC), dispatch_get_main_queue(), ^{
            if ([window.screen.deviceDescription[@"NSScreenNumber"] unsignedIntValue] != display || !NSEqualRects(window.frame, screen.frame) || !window.isVisible || !(window.occlusionState & NSWindowOcclusionStateVisible)) {
                [timer invalidate];
                [window close];
                result[@"status"] = @"skipped";
                result[@"reason"] = @"synthetic_window_not_visible_on_target_screen";
                report(result);
                exit(0);
            }
            dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
                @autoreleasepool {
                    bool uncertain = false;
                    uint64_t started = clock_gettime_nsec_np(CLOCK_UPTIME_RAW);
                    void *capture = rd_capture_create(display, 0, 0, Width, Height, Width, Height, Fps, Bitrate, 0, hevc, &uncertain);
                    PacketCounts counts = {0};
                    int status = capture ? 0 : -1;
                    if (capture) {
                        uint64_t deadline = clock_gettime_nsec_np(CLOCK_UPTIME_RAW) + 3 * NSEC_PER_SEC;
                        while (counts.packets < PacketLimit && clock_gettime_nsec_np(CLOCK_UPTIME_RAW) < deadline) {
                            bool boosted = false;
                            uint64_t timestamp = (clock_gettime_nsec_np(CLOCK_UPTIME_RAW) - started) / 1000;
                            status = rd_capture_next(capture, timestamp, counts.packets == 0, false, Bitrate, full_frame, &counts, &boosted, observe_packet, &counts);
                            if (status < 0) break;
                            usleep(1000000 / Fps);
                        }
                        uncertain = !rd_capture_destroy(capture);
                    }
                    result[@"status"] = status >= 0 && counts.packets && !uncertain ? @"passed" : @"failed";
                    result[@"reason"] = uncertain ? @"capture_shutdown_uncertain" : !capture ? @"capture_start_failed" : !counts.packets ? @"no_encoded_capture_packet" : status < 0 ? @"capture_next_failed" : @"encoded_synthetic_display_packets";
                    result[@"codec"] = selectedCodec;
                    result[@"markerChecks"] = @(counts.markerChecks);
                    result[@"markerMatches"] = @(counts.markerMatches);
                    if (!uncertain && counts.markerChecks != counts.markerMatches) result[@"reason"] = @"synthetic_marker_missing_before_encode";
                    result[@"encodedPackets"] = @(counts.packets);
                    result[@"encodedBytes"] = @(counts.bytes);
                    result[@"probeWallMs"] = @((clock_gettime_nsec_np(CLOCK_UPTIME_RAW) - started) / 1000000.0);
                    result[@"shutdownConfirmed"] = @(!uncertain);
                    dispatch_async(dispatch_get_main_queue(), ^{
                        [timer invalidate];
                        if (!uncertain) [window close];
                        report(result);
                        exit([result[@"status"] isEqual:@"passed"] ? 0 : 1);
                    });
                }
            });
        });
        [NSApp run];
        return 70;
    }
}
