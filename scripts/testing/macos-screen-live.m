#import <AppKit/AppKit.h>
#import <CoreGraphics/CoreGraphics.h>
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <pthread.h>
#include <pwd.h>
#include <signal.h>
#include <stdatomic.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <time.h>
#include <unistd.h>

extern int rd_permissions(void);
extern bool rd_probe_video(uint32_t, uint32_t, uint32_t, uint32_t, uint32_t *);
extern bool rd_probe_hevc(uint32_t, uint32_t, uint32_t, uint32_t, uint32_t, char *, size_t);
typedef bool (*Spatial)(void *, const uint8_t *, size_t, const uint8_t *, size_t, size_t, size_t, uint32_t *, uint32_t *, bool *);
typedef bool (*Packet)(void *, const uint8_t *, size_t, uint64_t);
extern void *rd_capture_create(uint32_t, double, double, double, double, uint32_t, uint32_t, uint32_t, uint32_t, uint32_t, bool, bool *);
extern int rd_capture_next(void *, uint64_t, bool, bool, uint32_t, Spatial, void *, bool *, Packet, void *);
extern bool rd_capture_destroy(void *);

enum { Width = 640, Height = 480, Fps = 60, Bitrate = 20000000, MaxID = 64, MaxPacket = 4 * 1024 * 1024 };
enum RecordKind { Startup = 1, EncodedFrame, GroupEnd, Fatal, Shutdown, Started };
typedef struct { uint64_t received, applied; } Action;
typedef struct {
    pthread_mutex_t actionsLock;
    Action actions[MaxID + 1];
    uint32_t appliedID;
    atomic_bool stop, groupPending;
    void *capture;
    bool shutdownUncertain, finishing;
    uint32_t lastEmittedID;
    uint64_t packets, bytes, markerChecks, markerMatches;
} Producer;
typedef struct {
    Producer *producer;
    uint32_t id, index;
    uint64_t markerRead;
    Action action;
    bool markerValid;
} Frame;

@interface LiveScene : NSView
@property uint32_t markerID;
@property NSSize markerSize;
@end
@implementation LiveScene
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

    [NSGraphicsContext saveGraphicsState];
    NSRectClip(NSMakeRect(w * .25, h * .20, w * .50, h * .20));
    NSDictionary *style = @{
        NSFontAttributeName: [NSFont monospacedSystemFontOfSize:w / 38 weight:NSFontWeightMedium],
        NSForegroundColorAttributeName: NSColor.whiteColor
    };
    for (unsigned row = 0; row <= 7; row++) {
        unsigned line = self.markerID / 2 + row;
        CGFloat y = h * .20 + (row * 24.0 - (self.markerID % 2) * 12.0) * h / Height;
        [[NSString stringWithFormat:@"Synthetic list item %03u", line] drawAtPoint:NSMakePoint(w * .27, y) withAttributes:style];
    }
    [NSGraphicsContext restoreGraphicsState];

    uint32_t marker = (UINT32_C(0xa5c3) << 16) | (self.markerID << 8) | ((~self.markerID) & 0xff);
    for (unsigned i = 0; i < 32; i++) {
        [(marker & (UINT32_C(1) << (31 - i))) ? NSColor.whiteColor : NSColor.blackColor setFill];
        NSRectFill(NSMakeRect((64 + 16 * i) * w / Width, 320 * h / Height, 16 * w / Width, 32 * h / Height));
    }
}
@end

static uint64_t micros(void) {
    return clock_gettime_nsec_np(CLOCK_UPTIME_RAW) / 1000;
}

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
        env_is("GITHUB_ACTIONS", "true") && env_is("RIEUL_HOSTED_SCREEN_SCROLL", "1") &&
        env_is("RUNNER_ENVIRONMENT", "github-hosted") &&
        env_is("RUNNER_OS", "macOS") && env_is("RUNNER_ARCH", "ARM64") &&
        env_is("GITHUB_SERVER_URL", "https://github.com") &&
        env_is("GITHUB_REPOSITORY", "disjukr/rieul.app") &&
        env_is("GITHUB_REF", "refs/heads/screen-hosted-live-scroll-test") &&
        env_is("GITHUB_EVENT_NAME", "workflow_dispatch") &&
        env_is("GITHUB_WORKFLOW", "Screen capture capability probe") &&
        env_is("GITHUB_WORKFLOW_REF", "disjukr/rieul.app/.github/workflows/probe-screen-fixture.yml@refs/heads/screen-hosted-live-scroll-test");
#endif
}

static bool prepare_private_pipes(void) {
    struct stat input, output;
    if (fstat(STDIN_FILENO, &input) || fstat(STDOUT_FILENO, &output)) return false;
    if (!S_ISFIFO(input.st_mode) || !S_ISFIFO(output.st_mode)) return false;
    int flags = fcntl(STDOUT_FILENO, F_GETFL);
    return flags >= 0 && fcntl(STDOUT_FILENO, F_SETFL, flags | O_NONBLOCK) == 0 &&
        signal(SIGPIPE, SIG_IGN) != SIG_ERR;
}

static bool write_all(const void *data, size_t length, uint64_t deadline) {
    const uint8_t *bytes = data;
    while (length) {
        uint64_t now = micros();
        if (now >= deadline) return false;
        ssize_t n = write(STDOUT_FILENO, bytes, length);
        if (n > 0) {
            bytes += n;
            length -= (size_t)n;
            continue;
        }
        if (n == 0) return false;
        if (errno == EINTR) continue;
        if (errno != EAGAIN && errno != EWOULDBLOCK) return false;
        struct pollfd fd = { .fd = STDOUT_FILENO, .events = POLLOUT };
        int status = poll(&fd, 1, (int)((deadline - now + 999) / 1000));
        if (status < 0 && errno == EINTR) continue;
        if (status <= 0 || !(fd.revents & POLLOUT)) return false;
    }
    return true;
}

static void put32(uint8_t *out, uint32_t n) {
    for (unsigned i = 0; i < 4; i++) out[i] = (uint8_t)(n >> (24 - 8 * i));
}

static void put64(uint8_t *out, uint64_t n) {
    for (unsigned i = 0; i < 8; i++) out[i] = (uint8_t)(n >> (56 - 8 * i));
}

static bool record(enum RecordKind kind, const void *payload, size_t length, const Frame *frame, uint64_t timestamp, uint64_t ready) {
    if (length > MaxPacket) return false;
    uint8_t header[64] = {'R', 'S', 'L', '1'};
    put32(header + 4, kind);
    put32(header + 8, (uint32_t)length);
    if (frame) {
        put32(header + 12, frame->id);
        put64(header + 16, timestamp);
        put64(header + 24, frame->action.received);
        put64(header + 32, frame->action.applied);
        put64(header + 40, frame->markerRead);
        put64(header + 48, ready);
        put32(header + 56, frame->index);
        put32(header + 60, frame->index == 0);
    }
    uint64_t deadline = micros() + 500000;
    return write_all(header, sizeof(header), deadline) && write_all(payload, length, deadline);
}

static bool json_record(enum RecordKind kind, NSDictionary *fields) {
    NSData *json = [NSJSONSerialization dataWithJSONObject:fields options:NSJSONWritingSortedKeys error:nil];
    return json && record(kind, json.bytes, json.length, NULL, 0, 0);
}

static bool source_frame(void *context, const uint8_t *luma, size_t stride, const uint8_t *chroma, size_t chromaStride, size_t width, size_t height, uint32_t *mask, uint32_t *target, bool *damaged) {
    Frame *frame = context;
    Producer *producer = frame->producer;
    producer->markerChecks++;
    if (!luma || !chroma || stride < Width || chromaStride < Width || width != Width || height != Height) return false;
    static const struct { unsigned x, y, low, high; } patches[] = {
        {10, 10, 210, 255}, {90, 10, 0, 40},
        {10, 90, 0, 40}, {90, 90, 210, 255},
        {50, 10, 80, 180}, {50, 90, 80, 180},
        {40, 50, 210, 255}, {60, 50, 0, 40}
    };
    for (size_t i = 0; i < sizeof(patches) / sizeof(patches[0]); i++) {
        size_t x = width * patches[i].x / 100, y = height * patches[i].y / 100;
        for (size_t dy = 0; dy < 5; dy++) for (size_t dx = 0; dx < 5; dx++) {
            unsigned value = luma[(y + dy) * stride + x + dx];
            if (value < patches[i].low || value > patches[i].high) return false;
        }
    }
    uint32_t marker = 0;
    for (unsigned i = 0; i < 32; i++) {
        uint8_t value = luma[336 * stride + 72 + 16 * i];
        if (value >= 60 && value <= 195) return false;
        marker = (marker << 1) | (value > 195);
    }
    uint32_t id = (marker >> 8) & 0xff;
    if ((marker >> 16) != 0xa5c3 || (marker & 0xff) != ((~id) & 0xff) || id > MaxID ||
        id < producer->lastEmittedID) return false;
    pthread_mutex_lock(&producer->actionsLock);
    bool known = id <= producer->appliedID;
    Action action = producer->actions[id];
    pthread_mutex_unlock(&producer->actionsLock);
    if (!known) return false;
    frame->id = id;
    frame->action = action;
    frame->markerValid = true;
    frame->markerRead = micros();
    producer->markerMatches++;
    *mask = UINT32_MAX;
    *target = Bitrate;
    *damaged = true;
    return true;
}

static bool emit_frame(void *context, const uint8_t *data, size_t length, uint64_t timestamp) {
    Frame *frame = context;
    uint64_t ready = micros();
    if (!frame->markerValid || !data || length == 0 || length > MaxPacket) return false;
    if (!record(EncodedFrame, data, length, frame, timestamp, ready)) return false;
    frame->producer->lastEmittedID = frame->id;
    frame->producer->packets++;
    frame->producer->bytes += length;
    return true;
}

static bool visible_scene(NSWindow *window, NSScreen *screen, CGDirectDisplayID display) {
    return [window.screen.deviceDescription[@"NSScreenNumber"] unsignedIntValue] == display &&
        NSEqualRects(window.frame, screen.frame) && window.isVisible &&
        (window.occlusionState & NSWindowOcclusionStateVisible);
}

static void finish(Producer *producer, NSWindow *window, NSString *failure) {
    if (producer->finishing) return;
    producer->finishing = true;
    atomic_store(&producer->stop, true);
    if (producer->capture) {
        producer->shutdownUncertain = !rd_capture_destroy(producer->capture);
        producer->capture = NULL;
    }
    bool confirmed = !producer->shutdownUncertain;
    if (!confirmed) failure = @"capture_shutdown_uncertain";
    bool reported = json_record(failure ? Fatal : Shutdown, @{
        @"status": failure ? @"failed" : @"stopped",
        @"reason": failure ?: @"requested_stop",
        @"shutdownConfirmed": @(confirmed),
        @"encodedPackets": @(producer->packets), @"encodedBytes": @(producer->bytes),
        @"markerChecks": @(producer->markerChecks), @"markerMatches": @(producer->markerMatches)
    });
    dispatch_async(dispatch_get_main_queue(), ^{
        if (confirmed) [window close];
        exit(failure || !reported ? 1 : 0);
    });
}

static NSString *produce_group(Producer *producer, uint32_t sequence, uint32_t count) {
    if (!producer->capture) return @"group_before_capture";
    uint64_t deadline = micros() + 3000000;
    uint32_t sent = 0;
    NSString *reason = @"requested_count";
    while (sent < count) {
        if (atomic_load(&producer->stop)) { reason = @"stop_requested"; break; }
        uint64_t start = micros();
        if (start >= deadline) { reason = @"group_deadline"; break; }
        Frame frame = { .producer = producer, .index = sent };
        bool boosted = false;
        int status = rd_capture_next(producer->capture, start, sent == 0, false, Bitrate, source_frame, &frame, &boosted, emit_frame, &frame);
        if (status < 0) return producer->markerChecks != producer->markerMatches ? @"synthetic_marker_missing_before_encode" : @"capture_or_private_pipe_failed";
        if (status == 2) { reason = @"unexpected_keyframe"; break; }
        if (status == 1) sent++;
        uint64_t next = start + 1000000 / Fps, now = micros();
        if (sent < count && next > now) usleep((useconds_t)(next - now));
    }
    NSString *status = sent == count ? @"complete" : atomic_load(&producer->stop) ? @"interrupted" : @"ended_early";
    atomic_store(&producer->groupPending, false);
    return json_record(GroupEnd, @{@"sequence": @(sequence), @"packets": @(sent), @"status": status, @"reason": reason}) ? nil : @"private_pipe_failed";
}

static bool number(const char *text, uint32_t max, uint32_t *value) {
    if (!text || !*text) return false;
    uint64_t n = 0;
    for (; *text; text++) {
        if (*text < '0' || *text > '9') return false;
        n = n * 10 + (unsigned)(*text - '0');
        if (n > max) return false;
    }
    *value = (uint32_t)n;
    return true;
}

static void commands(Producer *producer, NSWindow *window, NSScreen *screen, CGDirectDisplayID display, LiveScene *scene, NSString *h264, NSString *hevc) {
    dispatch_queue_t captureQueue = dispatch_queue_create("rieul.fixture.capture", DISPATCH_QUEUE_SERIAL);
    dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
        char line[128];
        bool startRequested = false;
        uint32_t lastGroup = 0, lastScroll = 0;
        NSString *failure = @"control_eof_without_stop";
        while (fgets(line, sizeof(line), stdin)) {
            @autoreleasepool {
                uint64_t received = micros();
                char *newline = strchr(line, '\n');
                if (!newline) { failure = @"invalid_control_line"; break; }
                *newline = '\0';
                char *rest = line;
                const char *operation = strsep(&rest, " ");
                if (!strcmp(operation, "STOP") && !rest) { failure = nil; break; }
                if (!strcmp(operation, "START") && rest && !startRequested) {
                    bool useHEVC = !strcmp(rest, "hevc");
                    NSString *selected = useHEVC ? hevc : !strcmp(rest, "h264") ? h264 : nil;
                    if (!selected) { failure = @"unsupported_requested_codec"; break; }
                    startRequested = true;
                    dispatch_async(captureQueue, ^{
                        __block bool visible = false;
                        dispatch_sync(dispatch_get_main_queue(), ^{ visible = visible_scene(window, screen, display); });
                        if (!visible || !(rd_permissions() & 1)) {
                            finish(producer, window, @"capture_permission_or_synthetic_window_lost");
                            return;
                        }
                        producer->capture = rd_capture_create(display, 0, 0, Width, Height, Width, Height, Fps, Bitrate, 0, useHEVC, &producer->shutdownUncertain);
                        if (!producer->capture || !json_record(Started, @{@"status": @"started", @"codec": selected})) {
                            finish(producer, window, @"capture_start_or_private_pipe_failed");
                        }
                    });
                } else if (!strcmp(operation, "GROUP") && rest && startRequested) {
                    uint32_t sequence, count;
                    const char *arg = strsep(&rest, " ");
                    if (!number(arg, UINT32_MAX, &sequence) || sequence <= lastGroup || !number(rest, 60, &count) || !count ||
                        atomic_exchange(&producer->groupPending, true)) { failure = @"invalid_group_request"; break; }
                    lastGroup = sequence;
                    dispatch_async(captureQueue, ^{
                        NSString *error = produce_group(producer, sequence, count);
                        if (error) finish(producer, window, error);
                    });
                } else if (!strcmp(operation, "SCROLL") && rest && startRequested) {
                    uint32_t id;
                    if (!number(rest, MaxID, &id) || id != lastScroll + 1) { failure = @"invalid_scroll_sequence"; break; }
                    lastScroll = id;
                    dispatch_sync(dispatch_get_main_queue(), ^{
                        pthread_mutex_lock(&producer->actionsLock);
                        producer->actions[id] = (Action){ .received = received, .applied = micros() };
                        producer->appliedID = id;
                        pthread_mutex_unlock(&producer->actionsLock);
                        scene.markerID = id;
                        [scene setNeedsDisplay:YES];
                        [scene displayIfNeeded];
                    });
                } else {
                    failure = @"invalid_control_command";
                    break;
                }
            }
        }
        atomic_store(&producer->stop, true);
        dispatch_async(captureQueue, ^{ finish(producer, window, failure); });
    });
}

int main(void) {
    @autoreleasepool {
        if (!hosted_fixture() || !prepare_private_pipes()) return 64;
        alarm(50);
        int permissions = rd_permissions();
        uint32_t h264Codec = 0;
        char hevcCodec[128] = {0};
        NSString *h264 = nil, *hevc = nil;
        if (permissions & 1) {
            if (rd_probe_video(Width, Height, Fps, Bitrate, &h264Codec)) h264 = [NSString stringWithFormat:@"avc1.%06x", h264Codec];
            if (rd_probe_hevc(Width, Height, Fps, Bitrate, 0, hevcCodec, sizeof(hevcCodec))) hevc = [NSString stringWithUTF8String:hevcCodec];
        }
        NSMutableDictionary *startup = [@{
            @"scope": @"hosted_synthetic_live_scroll_full_frame",
            @"os": NSProcessInfo.processInfo.operatingSystemVersionString,
            @"capturePermission": @((permissions & 1) != 0),
            @"inputPermission": @((permissions & 2) != 0),
            @"width": @(Width), @"height": @(Height), @"fpsTarget": @(Fps), @"bitrate": @(Bitrate),
            @"h264Codec": h264 ?: NSNull.null, @"hevcCodec": hevc ?: NSNull.null
        } mutableCopy];
        if (!(permissions & 1) || (!h264 && !hevc)) {
            startup[@"status"] = @"skipped";
            startup[@"reason"] = !(permissions & 1) ? @"capture_permission_or_console_unavailable" : @"required_hardware_encoder_unavailable";
            return json_record(Startup, startup) ? 0 : 1;
        }
        [NSApplication sharedApplication];
        [NSApp setActivationPolicy:NSApplicationActivationPolicyRegular];
        [NSApp finishLaunching];
        NSScreen *screen = NSScreen.mainScreen;
        CGDirectDisplayID display = [screen.deviceDescription[@"NSScreenNumber"] unsignedIntValue];
        if (!screen || CGDisplayPixelsWide(display) < Width || CGDisplayPixelsHigh(display) < Height) {
            startup[@"status"] = @"skipped";
            startup[@"reason"] = @"no_suitable_runner_display";
            return json_record(Startup, startup) ? 0 : 1;
        }
        double scale = CGDisplayPixelsWide(display) / CGDisplayBounds(display).size.width;
        NSWindow *window = [[NSWindow alloc] initWithContentRect:screen.frame styleMask:NSWindowStyleMaskBorderless backing:NSBackingStoreBuffered defer:NO];
        window.releasedWhenClosed = NO;
        window.level = NSScreenSaverWindowLevel;
        window.opaque = YES;
        LiveScene *scene = [[LiveScene alloc] initWithFrame:NSMakeRect(0, 0, screen.frame.size.width, screen.frame.size.height)];
        scene.markerSize = NSMakeSize(Width / scale, Height / scale);
        window.contentView = scene;
        [window setFrame:screen.frame display:YES];
        [window makeKeyAndOrderFront:nil];
        [NSApp activateIgnoringOtherApps:YES];
        [window display];

        Producer *producer = calloc(1, sizeof(*producer));
        if (!producer || pthread_mutex_init(&producer->actionsLock, NULL)) return 70;
        atomic_init(&producer->stop, false);
        atomic_init(&producer->groupPending, false);
        dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 45 * NSEC_PER_SEC), dispatch_get_main_queue(), ^{ _exit(75); });
        dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 250 * NSEC_PER_MSEC), dispatch_get_main_queue(), ^{
            if (!visible_scene(window, screen, display)) {
                startup[@"status"] = @"skipped";
                startup[@"reason"] = @"synthetic_window_not_visible_on_target_screen";
                exit(json_record(Startup, startup) ? 0 : 1);
            }
            startup[@"status"] = @"ready";
            if (!json_record(Startup, startup)) exit(1);
            commands(producer, window, screen, display, scene, h264, hevc);
        });
        [NSApp run];
        return 70;
    }
}
