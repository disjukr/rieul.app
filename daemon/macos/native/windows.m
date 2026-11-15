// Promptless, read-only Quartz metadata. Never capture pixels or consult AX.
#import <Foundation/Foundation.h>
#import <ApplicationServices/ApplicationServices.h>
#include <unistd.h>
#include <math.h>
#include <string.h>

static const NSUInteger RDMaxWindows = 512;
static const NSUInteger RDMaxScan = 8192;
static const NSUInteger RDMaxTitleBytes = 512;

bool rd_windows_session_active(void) {
    NSDictionary *session = CFBridgingRelease(CGSessionCopyCurrentDictionary());
    return session && [session[(__bridge NSString *)kCGSessionUserIDKey] unsignedIntValue] == getuid()
        && [session[(__bridge NSString *)kCGSessionOnConsoleKey] boolValue]
        && [session[(__bridge NSString *)kCGSessionLoginDoneKey] boolValue];
}

static NSNumber *rd_number(id value) {
    return [value isKindOfClass:[NSNumber class]] ? value : nil;
}

// Shared by the live adapter and synthetic fixtures. Overflow is an error, not a
// truncated snapshot: truncation would falsely remove still-existing windows.
static NSData *rd_window_metadata(NSArray *windows) {
    if (!windows || windows.count > RDMaxScan) return nil;
    NSMutableArray *rows = [NSMutableArray array];
    for (id item in windows) {
        if (![item isKindOfClass:[NSDictionary class]]) return nil;
        NSDictionary *w = item;
        NSNumber *layer = rd_number(w[(__bridge NSString *)kCGWindowLayer]);
        NSNumber *number = rd_number(w[(__bridge NSString *)kCGWindowNumber]);
        NSNumber *pid = rd_number(w[(__bridge NSString *)kCGWindowOwnerPID]);
        if (!layer || !number || !pid) return nil;
        if (layer.integerValue != 0) continue;
        CGRect bounds;
        id rect = w[(__bridge NSString *)kCGWindowBounds];
        if (![rect isKindOfClass:[NSDictionary class]] ||
            !CGRectMakeWithDictionaryRepresentation((__bridge CFDictionaryRef)rect, &bounds)) return nil;
        double x = round(bounds.origin.x), y = round(bounds.origin.y);
        double width = round(bounds.size.width), height = round(bounds.size.height);
        if (!isfinite(x) || !isfinite(y) || !isfinite(width) || !isfinite(height) ||
            fabs(x) > 9007199254740991.0 || fabs(y) > 9007199254740991.0 ||
            width > 9007199254740991.0 || height > 9007199254740991.0) return nil;
        if (number.unsignedLongLongValue == 0 || number.unsignedLongLongValue > UINT32_MAX ||
            pid.longLongValue <= 0 || pid.longLongValue > INT32_MAX || width <= 0 || height <= 0) continue;
        if (rows.count >= RDMaxWindows) return nil;
        NSMutableDictionary *row = [@{@"id":number, @"pid":pid, @"x":@((long long)x), @"y":@((long long)y),
            @"width":@((unsigned long long)width), @"height":@((unsigned long long)height)} mutableCopy];
        id title = w[(__bridge NSString *)kCGWindowName];
        if ([title isKindOfClass:[NSString class]] && [title length]) {
            // Limit work before converting; preserve complete composed characters.
            NSString *bounded = [title substringToIndex:MIN([title length], RDMaxTitleBytes)];
            while ([bounded lengthOfBytesUsingEncoding:NSUTF8StringEncoding] > RDMaxTitleBytes ||
                   ![bounded dataUsingEncoding:NSUTF8StringEncoding]) {
                if (!bounded.length) break;
                bounded = [bounded substringToIndex:[bounded rangeOfComposedCharacterSequenceAtIndex:bounded.length - 1].location];
            }
            if (bounded.length) row[@"title"] = bounded;
        }
        NSNumber *visible = rd_number(w[(__bridge NSString *)kCGWindowIsOnscreen]);
        if (visible) row[@"visible"] = @([visible boolValue]);
        [rows addObject:row];
    }
    return [NSJSONSerialization dataWithJSONObject:rows options:0 error:nil];
}

size_t rd_windows_snapshot(uint8_t *output, size_t capacity) {
    @autoreleasepool {
        if (!output || !rd_windows_session_active()) return 0;
        NSArray *windows = CFBridgingRelease(CGWindowListCopyWindowInfo(
            kCGWindowListOptionAll | kCGWindowListExcludeDesktopElements, kCGNullWindowID));
        NSData *data = rd_window_metadata(windows);
        if (!data || data.length > capacity || !rd_windows_session_active()) return 0;
        memcpy(output, data.bytes, data.length);
        return data.length;
    }
}

// No WindowServer queries, permission checks, input, or capture in this fixture.
bool rd_test_window_metadata(void) {
    @autoreleasepool {
        NSDictionary *bounds = CFBridgingRelease(CGRectCreateDictionaryRepresentation(CGRectMake(-12, 4, 800, 600)));
        NSMutableDictionary *w = [@{(__bridge NSString *)kCGWindowLayer:@0,
            (__bridge NSString *)kCGWindowNumber:@42, (__bridge NSString *)kCGWindowOwnerPID:@99,
            (__bridge NSString *)kCGWindowBounds:bounds, (__bridge NSString *)kCGWindowIsOnscreen:@NO} mutableCopy];
        NSArray *rows = [NSJSONSerialization JSONObjectWithData:rd_window_metadata(@[w]) options:0 error:nil];
        if (rows.count != 1 || rows[0][@"title"] || [rows[0][@"visible"] boolValue] || [rows[0][@"x"] intValue] != -12) return false;
        w[(__bridge NSString *)kCGWindowName] = [@"한" stringByPaddingToLength:1024 withString:@"한" startingAtIndex:0];
        rows = [NSJSONSerialization JSONObjectWithData:rd_window_metadata(@[w]) options:0 error:nil];
        if ([rows[0][@"title"] lengthOfBytesUsingEncoding:NSUTF8StringEncoding] > RDMaxTitleBytes) return false;
        w[(__bridge NSString *)kCGWindowLayer] = @1;
        rows = [NSJSONSerialization JSONObjectWithData:rd_window_metadata(@[w]) options:0 error:nil];
        if (rows.count != 0) return false;
        w[(__bridge NSString *)kCGWindowLayer] = @0;
        NSMutableArray *many = [NSMutableArray array];
        for (NSUInteger i=0; i<=RDMaxWindows; i++) [many addObject:w];
        return rd_window_metadata(many) == nil && rd_window_metadata(nil) == nil;
    }
}
