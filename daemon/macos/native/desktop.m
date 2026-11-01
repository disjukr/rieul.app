// User-session adapter. No permission prompts or automatic capture at initialization.
#import <Foundation/Foundation.h>
#import <Security/Security.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <bsm/audit.h>
#import <ScreenCaptureKit/ScreenCaptureKit.h>
#import <VideoToolbox/VideoToolbox.h>
#import <ApplicationServices/ApplicationServices.h>
#include <stdint.h>
#include <stdbool.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

// Bind identity to the kernel peer audit token (including PID generation), not
// a pathname or a reusable PID. Both roles execute the exact same signed binary.
bool rd_peer_matches_self(int fd) {
    audit_token_t token;
    socklen_t length=sizeof(token);
    if(getsockopt(fd,SOL_LOCAL,LOCAL_PEERTOKEN,&token,&length) || length!=sizeof(token)) return false;
    @autoreleasepool {
        NSData *audit=[NSData dataWithBytes:&token length:sizeof(token)];
        NSDictionary *attributes=@{(__bridge NSString *)kSecGuestAttributeAudit:audit};
        SecCodeRef own=NULL,peer=NULL;
        SecStaticCodeRef ownStatic=NULL,peerStatic=NULL;
        CFDictionaryRef ownInfo=NULL,peerInfo=NULL;
        bool ok=false;
        if(SecCodeCopySelf(kSecCSDefaultFlags,&own)!=errSecSuccess ||
           SecCodeCopyGuestWithAttributes(NULL,(__bridge CFDictionaryRef)attributes,kSecCSDefaultFlags,&peer)!=errSecSuccess ||
           SecCodeCheckValidity(own,kSecCSDefaultFlags,NULL)!=errSecSuccess ||
           SecCodeCheckValidity(peer,kSecCSDefaultFlags,NULL)!=errSecSuccess ||
           SecCodeCopyStaticCode(own,kSecCSDefaultFlags,&ownStatic)!=errSecSuccess ||
           SecCodeCopyStaticCode(peer,kSecCSDefaultFlags,&peerStatic)!=errSecSuccess ||
           SecCodeCopySigningInformation(ownStatic,kSecCSSigningInformation,&ownInfo)!=errSecSuccess ||
           SecCodeCopySigningInformation(peerStatic,kSecCSSigningInformation,&peerInfo)!=errSecSuccess) goto cleanup;
        {
            CFTypeRef a=CFDictionaryGetValue(ownInfo,kSecCodeInfoUnique);
            CFTypeRef b=CFDictionaryGetValue(peerInfo,kSecCodeInfoUnique);
            ok=a && b && CFGetTypeID(a)==CFDataGetTypeID() && CFGetTypeID(b)==CFDataGetTypeID() && CFEqual(a,b);
        }
    cleanup:
        if(peerInfo) CFRelease(peerInfo);
        if(ownInfo) CFRelease(ownInfo);
        if(peerStatic) CFRelease(peerStatic);
        if(ownStatic) CFRelease(ownStatic);
        if(peer) CFRelease(peer);
        if(own) CFRelease(own);
        return ok;
    }
}

typedef struct { uint32_t id; double x,y,width,height,scale,dpi; } RDDisplay;
typedef bool (*RDPacket)(void *, const uint8_t *, size_t, uint64_t);
int rd_permissions(void) {
    struct stat console;
    if(geteuid()==0 || stat("/dev/console",&console) || console.st_uid!=geteuid()) return 0;
    CFDictionaryRef session=CGSessionCopyCurrentDictionary();
    if(!session) return 0;
    bool active=CFDictionaryGetValue(session,kCGSessionOnConsoleKey)==kCFBooleanTrue && CFDictionaryGetValue(session,kCGSessionLoginDoneKey)==kCFBooleanTrue;
    CFRelease(session);
    if(!active) return 0;
    return (CGPreflightScreenCaptureAccess() ? 1 : 0) | (AXIsProcessTrusted() ? 2 : 0);
}
size_t rd_displays(RDDisplay *out, size_t capacity) {
    CGDirectDisplayID ids[32]; uint32_t count=0;
    if (CGGetActiveDisplayList(32, ids, &count) != kCGErrorSuccess) return 0;
    for (size_t i=0;i<count && i<capacity;i++) {
        CGRect b=CGDisplayBounds(ids[i]); CGSize mm=CGDisplayScreenSize(ids[i]);
        double w=CGDisplayPixelsWide(ids[i]), h=CGDisplayPixelsHigh(ids[i]);
        out[i]=(RDDisplay){ids[i],b.origin.x,b.origin.y,w,h,b.size.width>0?w/b.size.width:1,mm.width>0?w*25.4/mm.width:96};
    }
    return MIN(count,capacity);
}
static VTCompressionSessionRef encoder(uint32_t width,uint32_t height,uint32_t fps,uint32_t bitrate,VTCompressionOutputCallback callback,void *ref) {
    VTCompressionSessionRef session=NULL;
    NSDictionary *spec=@{(__bridge NSString *)kVTVideoEncoderSpecification_RequireHardwareAcceleratedVideoEncoder:@YES};
    OSStatus status=VTCompressionSessionCreate(NULL,width,height,kCMVideoCodecType_H264,(__bridge CFDictionaryRef)spec,NULL,NULL,callback,ref,&session);
    if(status || !session) return NULL;
    NSDictionary *props=@{(__bridge NSString *)kVTCompressionPropertyKey_RealTime:@YES,
      (__bridge NSString *)kVTCompressionPropertyKey_AllowFrameReordering:@NO,
      (__bridge NSString *)kVTCompressionPropertyKey_ProfileLevel:(__bridge NSString *)kVTProfileLevel_H264_Baseline_4_2,
      (__bridge NSString *)kVTCompressionPropertyKey_ExpectedFrameRate:@(fps),
      (__bridge NSString *)kVTCompressionPropertyKey_AverageBitRate:@(bitrate)};
    if(VTSessionSetProperties(session,(__bridge CFDictionaryRef)props) || VTCompressionSessionPrepareToEncodeFrames(session)) { VTCompressionSessionInvalidate(session); CFRelease(session); return NULL; }
    CFTypeRef hardware=NULL;
    status=VTSessionCopyProperty(session,kVTCompressionPropertyKey_UsingHardwareAcceleratedVideoEncoder,NULL,&hardware);
    bool supported=!status && hardware==kCFBooleanTrue;
    if(hardware) CFRelease(hardware);
    if(!supported) { VTCompressionSessionInvalidate(session); CFRelease(session); return NULL; }
    return session;
}
@interface RDStream : NSObject<SCStreamOutput,SCStreamDelegate> {
@public
    SCStream *stream;
    dispatch_queue_t queue;
    dispatch_semaphore_t ready;
    CVPixelBufferRef latest;
    uint64_t serial, consumed;
    BOOL stopped;
    VTCompressionSessionRef compression;
    NSMutableData *packet;
    BOOL encodeFailed;
}
@end
static void encoded(void *ref,void *source,OSStatus status,VTEncodeInfoFlags flags,CMSampleBufferRef sample) {
    (void)source;
    RDStream *self=(__bridge RDStream *)ref;
    if(status || !sample || (flags & kVTEncodeInfo_FrameDropped)) { self->encodeFailed=YES; return; }
    CFArrayRef attachments=CMSampleBufferGetSampleAttachmentsArray(sample,false);
    if(attachments && CFArrayGetCount(attachments) && CFDictionaryContainsKey(CFArrayGetValueAtIndex(attachments,0),kCMSampleAttachmentKey_NotSync)) { self->encodeFailed=YES; return; }
    CMFormatDescriptionRef format=CMSampleBufferGetFormatDescription(sample);
    int lengthSize=0; size_t count=0;
    if(CMVideoFormatDescriptionGetH264ParameterSetAtIndex(format,0,NULL,NULL,&count,&lengthSize) || lengthSize!=4) { self->encodeFailed=YES; return; }
    const uint8_t prefix[]={0,0,0,1};
    for(size_t i=0;i<count;i++) {
        const uint8_t *bytes=NULL; size_t length=0;
        if(CMVideoFormatDescriptionGetH264ParameterSetAtIndex(format,i,&bytes,&length,NULL,NULL) || length>4*1024*1024) { self->encodeFailed=YES; return; }
        [self->packet appendBytes:prefix length:4]; [self->packet appendBytes:bytes length:length];
    }
    CMBlockBufferRef block=CMSampleBufferGetDataBuffer(sample);
    size_t size=CMBlockBufferGetDataLength(block);
    if(size>4*1024*1024) { self->encodeFailed=YES; return; }
    NSMutableData *data=[NSMutableData dataWithLength:size];
    if(CMBlockBufferCopyDataBytes(block,0,size,data.mutableBytes)) { self->encodeFailed=YES; return; }
    const uint8_t *bytes=data.bytes; size_t offset=0;
    while(offset+4<=size) {
        uint32_t n=((uint32_t)bytes[offset]<<24)|((uint32_t)bytes[offset+1]<<16)|((uint32_t)bytes[offset+2]<<8)|bytes[offset+3]; offset+=4;
        if(!n || n>size-offset || self->packet.length+n+4>4*1024*1024) { self->encodeFailed=YES; return; }
        [self->packet appendBytes:prefix length:4]; [self->packet appendBytes:bytes+offset length:n]; offset+=n;
    }
    if(offset!=size) self->encodeFailed=YES;
}
@implementation RDStream
- (void)stream:(SCStream *)s didStopWithError:(NSError *)error { @synchronized(self) { stopped=YES; } dispatch_semaphore_signal(ready); }
- (void)stream:(SCStream *)s didOutputSampleBuffer:(CMSampleBufferRef)sample ofType:(SCStreamOutputType)type {
    if(type!=SCStreamOutputTypeScreen || !CMSampleBufferIsValid(sample)) return;
    CVPixelBufferRef image=CMSampleBufferGetImageBuffer(sample); if(!image) return;
    CFArrayRef attachments=CMSampleBufferGetSampleAttachmentsArray(sample,false);
    if(!attachments || !CFArrayGetCount(attachments)) return;
    NSDictionary *info=(__bridge NSDictionary *)CFArrayGetValueAtIndex(attachments,0);
    if([info[SCStreamFrameInfoStatus] integerValue]!=SCFrameStatusComplete) return;
    @synchronized(self) { if(stopped) return; if(latest) CVPixelBufferRelease(latest); latest=CVPixelBufferRetain(image); serial++; }
    dispatch_semaphore_signal(ready);
}
- (void)dealloc { if(compression) { VTCompressionSessionInvalidate(compression); CFRelease(compression); } if(latest) CVPixelBufferRelease(latest); }
@end
static bool synthetic_frame(uint32_t *codec,RDPacket emit,void *context) {
    @autoreleasepool {
        RDStream *self=[RDStream new]; self->packet=[NSMutableData new];
        self->compression=encoder(640,480,60,2000000,encoded,(__bridge void *)self);
        if(!self->compression) return false;
        CVPixelBufferRef image=NULL;
        if(CVPixelBufferCreate(NULL,640,480,kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange,NULL,&image)) return false;
        CVPixelBufferLockBaseAddress(image,0);
        for(size_t plane=0;plane<2;plane++) memset(CVPixelBufferGetBaseAddressOfPlane(image,plane),plane?128:16,CVPixelBufferGetBytesPerRowOfPlane(image,plane)*CVPixelBufferGetHeightOfPlane(image,plane));
        CVPixelBufferUnlockBaseAddress(image,0);
        NSDictionary *options=@{(__bridge NSString *)kVTEncodeFrameOptionKey_ForceKeyFrame:@YES};
        OSStatus status=VTCompressionSessionEncodeFrame(self->compression,image,kCMTimeZero,kCMTimeInvalid,(__bridge CFDictionaryRef)options,NULL,NULL);
        CVPixelBufferRelease(image);
        if(!status) status=VTCompressionSessionCompleteFrames(self->compression,kCMTimeInvalid);
        if(status || self->encodeFailed || self->packet.length<8) return false;
        const uint8_t *bytes=self->packet.bytes;
        if((bytes[4]&31)!=7) return false;
        *codec=((uint32_t)bytes[5]<<16)|((uint32_t)bytes[6]<<8)|bytes[7];
        return !emit || emit(context,self->packet.bytes,self->packet.length,0);
    }
}
bool rd_hardware_codec(uint32_t *codec) { return synthetic_frame(codec,NULL,NULL); }
bool rd_synthetic_packet(RDPacket emit,void *context) { uint32_t codec; return synthetic_frame(&codec,emit,context); }
bool rd_capture_destroy(void *handle);
// The returned object owns a bounded (latest only) frame slot and a hardware session.
void *rd_capture_create(uint32_t id,double x,double y,double w,double h,uint32_t width,uint32_t height,uint32_t fps,uint32_t bitrate,bool *shutdown_failed) {
    @autoreleasepool {
        *shutdown_failed=false;
        if(!(rd_permissions() & 1) || !width || !height || width>3840 || height>2160 || !fps || fps>120) return NULL;
        dispatch_semaphore_t done=dispatch_semaphore_create(0);
        __block SCShareableContent *content=nil;
        [SCShareableContent getShareableContentExcludingDesktopWindows:NO onScreenWindowsOnly:YES completionHandler:^(SCShareableContent *value,NSError *error) { (void)error; content=value; dispatch_semaphore_signal(done); }];
        if(dispatch_semaphore_wait(done,dispatch_time(DISPATCH_TIME_NOW,2*NSEC_PER_SEC))) return NULL;
        SCDisplay *display=nil;
        for(SCDisplay *candidate in content.displays) if(candidate.displayID==id) { display=candidate; break; }
        if(!display) return NULL;
        RDStream *self=[RDStream new]; self->ready=dispatch_semaphore_create(0); self->queue=dispatch_queue_create("rieul.desktop.capture",DISPATCH_QUEUE_SERIAL);
        self->compression=encoder(width,height,fps,bitrate,encoded,(__bridge void *)self); if(!self->compression) return NULL;
        SCStreamConfiguration *config=[SCStreamConfiguration new];
        config.width=width; config.height=height; config.pixelFormat=kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange;
        config.queueDepth=3; config.minimumFrameInterval=CMTimeMake(1,fps); config.showsCursor=NO;
        CGRect bounds=CGDisplayBounds(id); double scale=CGDisplayPixelsWide(id)/bounds.size.width;
        if(x<0 || y<0 || w<=0 || h<=0 || x+w>CGDisplayPixelsWide(id) || y+h>CGDisplayPixelsHigh(id)) return NULL;
        config.sourceRect=CGRectMake(x/scale,y/scale,w/scale,h/scale);
        SCContentFilter *filter=[[SCContentFilter alloc] initWithDisplay:display excludingWindows:@[]];
        self->stream=[[SCStream alloc] initWithFilter:filter configuration:config delegate:self];
        NSError *error=nil;
        if(![self->stream addStreamOutput:self type:SCStreamOutputTypeScreen sampleHandlerQueue:self->queue error:&error]) return NULL;
        __block BOOL ok=NO;
        [self->stream startCaptureWithCompletionHandler:^(NSError *error) { ok=error==nil; dispatch_semaphore_signal(done); }];
        if(dispatch_semaphore_wait(done,dispatch_time(DISPATCH_TIME_NOW,2*NSEC_PER_SEC)) || !ok) { *shutdown_failed=!rd_capture_destroy((__bridge_retained void *)self); return NULL; }
        return (__bridge_retained void *)self;
    }
}
bool rd_capture_destroy(void *handle) {
    if(!handle) return true;
    RDStream *self=(__bridge_transfer RDStream *)handle;
    @synchronized(self) { self->stopped=YES; }
    dispatch_semaphore_t done=dispatch_semaphore_create(0);
    __block BOOL stopped=NO;
    [self->stream stopCaptureWithCompletionHandler:^(NSError *e) { stopped=(e==nil); dispatch_semaphore_signal(done); }];
    dispatch_semaphore_wait(done,DISPATCH_TIME_FOREVER);
    dispatch_sync(self->queue, ^{});
    self->stream=nil;
    return stopped;
}
int rd_capture_next(void *handle,uint64_t timestamp,RDPacket emit,void *context) {
    @autoreleasepool {
        RDStream *self=(__bridge RDStream *)handle; CVPixelBufferRef image=NULL;
        uint64_t until=clock_gettime_nsec_np(CLOCK_UPTIME_RAW)+500*NSEC_PER_MSEC;
        while(!image) {
            @synchronized(self) {
                if(self->stopped || !(rd_permissions() & 1)) return -1;
                if(self->latest && self->serial!=self->consumed) { image=CVPixelBufferRetain(self->latest); self->consumed=self->serial; }
            }
            if(image) break;
            if(clock_gettime_nsec_np(CLOCK_UPTIME_RAW)>=until) return 0;
            dispatch_semaphore_wait(self->ready,dispatch_time(DISPATCH_TIME_NOW,20*NSEC_PER_MSEC));
        }
        self->packet=[NSMutableData new]; self->encodeFailed=NO;
        // v1 native adapter uses one-frame independent GOPs, always H.264 hardware.
        NSDictionary *options=@{(__bridge NSString *)kVTEncodeFrameOptionKey_ForceKeyFrame:@YES};
        OSStatus status=VTCompressionSessionEncodeFrame(self->compression,image,CMTimeMake(timestamp,1000000),kCMTimeInvalid,(__bridge CFDictionaryRef)options,NULL,NULL);
        CVPixelBufferRelease(image);
        if(!status) status=VTCompressionSessionCompleteFrames(self->compression,kCMTimeInvalid);
        if(status || self->encodeFailed || !self->packet.length) return -1;
        return emit(context,self->packet.bytes,self->packet.length,timestamp)?1:-1;
    }
}
// CGEvent injection is called only by the authenticated user-session dispatcher.
bool rd_key(uint16_t code,bool down,bool repeat,uint64_t flags) {
    if(!(rd_permissions() & 2)) return false;
    CGEventRef event=CGEventCreateKeyboardEvent(NULL,code,down); if(!event) return false;
    CGEventSetFlags(event,flags); CGEventSetIntegerValueField(event,kCGKeyboardEventAutorepeat,repeat);
    CGEventPost(kCGHIDEventTap,event); CFRelease(event); return true;
}
bool rd_mouse(uint32_t type,uint32_t button,double x,double y,uint64_t flags) {
    if(!(rd_permissions() & 2)) return false;
    CGEventRef event=CGEventCreateMouseEvent(NULL,type,CGPointMake(x,y),button); if(!event) return false;
    CGEventSetFlags(event,flags); CGEventPost(kCGHIDEventTap,event); CFRelease(event); return true;
}
bool rd_wheel(int32_t x,int32_t y,bool pixels) {
    if(!(rd_permissions() & 2)) return false;
    CGEventRef event=CGEventCreateScrollWheelEvent(NULL,pixels?kCGScrollEventUnitPixel:kCGScrollEventUnitLine,2,y,x); if(!event) return false;
    CGEventPost(kCGHIDEventTap,event); CFRelease(event); return true;
}

#import <AppKit/AppKit.h>
typedef struct { double x,y; uint32_t hotspot_x,hotspot_y; bool visible; } RDCursor;
bool rd_pointer_position(double *x,double *y) {
    CGEventRef event=CGEventCreate(NULL); if(!event) return false;
    CGPoint point=CGEventGetLocation(event);CFRelease(event);
    *x=point.x;*y=point.y;return true;
}
size_t rd_cursor(RDCursor *result,uint8_t *png,size_t capacity) {
    @autoreleasepool {
        memset(result,0,sizeof(*result));
        if(!(rd_permissions() & 1)) return 0;
        CGEventRef event=CGEventCreate(NULL); if(!event) return 0;
        CGPoint point=CGEventGetLocation(event);CFRelease(event);
        result->x=point.x;result->y=point.y;
        NSCursor *cursor=[NSCursor currentSystemCursor];if(!cursor) return 0;
        NSBitmapImageRep *rep=[NSBitmapImageRep imageRepWithData:cursor.image.TIFFRepresentation];
        if(!rep || rep.pixelsWide>256 || rep.pixelsHigh>256) return 0;
        NSData *data=[rep representationUsingType:NSBitmapImageFileTypePNG properties:@{}];
        if(!data || data.length>capacity) return 0;
        result->visible=true;result->hotspot_x=(uint32_t)MAX(0,cursor.hotSpot.x*rep.pixelsWide/cursor.image.size.width);result->hotspot_y=(uint32_t)MAX(0,cursor.hotSpot.y*rep.pixelsHigh/cursor.image.size.height);
        memcpy(png,data.bytes,data.length);return data.length;
    }
}

// Diagnostic availability probe only. This is not advertised as AV1 encoding:
// an actual packet/OBU implementation and successful synthetic encode are required.
bool rd_av1_hardware_encoder_available(void) {
    @autoreleasepool {
        VTCompressionSessionRef session=NULL;
        NSDictionary *spec=@{(__bridge NSString *)kVTVideoEncoderSpecification_RequireHardwareAcceleratedVideoEncoder:@YES};
        OSStatus status=VTCompressionSessionCreate(NULL,640,480,kCMVideoCodecType_AV1,(__bridge CFDictionaryRef)spec,NULL,NULL,NULL,NULL,&session);
        if(status || !session) return false;
        CFTypeRef value=NULL;
        status=VTSessionCopyProperty(session,kVTCompressionPropertyKey_UsingHardwareAcceleratedVideoEncoder,NULL,&value);
        bool hardware=status==noErr && value==kCFBooleanTrue;
        if(value) CFRelease(value);
        VTCompressionSessionInvalidate(session);CFRelease(session);
        return hardware;
    }
}
