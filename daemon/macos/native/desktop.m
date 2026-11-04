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

// Read-only XNU queries: CS_OPS_STATUS=0, CS_OPS_CDHASH=5, CS_VALID=1.
// Audit-token queries fence PID reuse and do not open the protected runtime.
// See apple-oss-distributions/xnu bsd/kern/kern_proc.c:csops_internal.
extern int csops(pid_t, unsigned int, void *, size_t);
extern int csops_audittoken(pid_t, unsigned int, void *, size_t, audit_token_t *);
bool rd_peer_matches_self(int fd) {
    audit_token_t token;
    socklen_t length=sizeof(token);
    if(getsockopt(fd,SOL_LOCAL,LOCAL_PEERTOKEN,&token,&length) || length!=sizeof(token)) return false;
    pid_t pid=(pid_t)token.val[5];
    uint32_t ownStatus=0,peerStatus=0;
    uint8_t ownHash[20],peerHash[20];
    if(pid<=0 || csops(getpid(),0,&ownStatus,sizeof(ownStatus)) ||
       csops_audittoken(pid,0,&peerStatus,sizeof(peerStatus),&token) ||
       !(ownStatus&1) || !(peerStatus&1) ||
       csops(getpid(),5,ownHash,sizeof(ownHash)) ||
       csops_audittoken(pid,5,peerHash,sizeof(peerHash),&token) ||
       csops_audittoken(pid,0,&peerStatus,sizeof(peerStatus),&token) || !(peerStatus&1) ||
       csops(getpid(),0,&ownStatus,sizeof(ownStatus)) || !(ownStatus&1)) return false;
    return memcmp(ownHash,peerHash,sizeof(ownHash))==0;
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
    // A maximum, not a prohibition on spontaneous IDRs; recovery still handles those.
    VTSessionSetProperty(session,kVTCompressionPropertyKey_MaxKeyFrameInterval,(__bridge CFNumberRef)@60);
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
    BOOL encodeFailed, wantKey, retryKey;
    uint32_t bitrate;
    BOOL bitrateUnsupported;
    NSArray *stripes;
    CVPixelBufferRef stripeImage;
    uint32_t stripeY, imageWidth, imageHeight;
}
@end
static void encoded(void *ref,void *source,OSStatus status,VTEncodeInfoFlags flags,CMSampleBufferRef sample) {
    (void)source;
    RDStream *self=(__bridge RDStream *)ref;
    if(status || !sample || (flags & kVTEncodeInfo_FrameDropped)) { self->encodeFailed=YES; return; }
    CFArrayRef attachments=CMSampleBufferGetSampleAttachmentsArray(sample,false);
    bool key=!(attachments && CFArrayGetCount(attachments) && CFDictionaryContainsKey(CFArrayGetValueAtIndex(attachments,0),kCMSampleAttachmentKey_NotSync));
    if(key!=self->wantKey) { if(key) self->retryKey=YES; else self->encodeFailed=YES; return; }
    CMFormatDescriptionRef format=CMSampleBufferGetFormatDescription(sample);
    int lengthSize=0; size_t count=0;
    if(CMVideoFormatDescriptionGetH264ParameterSetAtIndex(format,0,NULL,NULL,&count,&lengthSize) || lengthSize!=4) { self->encodeFailed=YES; return; }
    const uint8_t prefix[]={0,0,0,1};
    for(size_t i=0;key && i<count;i++) {
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
    @synchronized(self) { if(stopped) return; NSArray *dirty=info[SCStreamFrameInfoDirtyRects]; if(latest && dirty && dirty.count==0) return; if(latest) CVPixelBufferRelease(latest); latest=CVPixelBufferRetain(image); serial++; }
    dispatch_semaphore_signal(ready);
}
- (void)dealloc { if(compression) { VTCompressionSessionInvalidate(compression); CFRelease(compression); } if(latest) CVPixelBufferRelease(latest); if(stripeImage) CVPixelBufferRelease(stripeImage); }
@end
// All stripe sessions are constructed together before capture starts. No x264.
static bool configure_pipeline(RDStream *self,uint32_t width,uint32_t height,uint32_t fps,uint32_t bitrate,uint32_t count) {
    if(!width || !height || width%2 || height%2 || width>3840 || height>2160 || count>2 || bitrate<count) return false;
    self->imageWidth=width; self->imageHeight=height; self->bitrate=bitrate;
    if(!count) { self->compression=encoder(width,height,fps,bitrate,encoded,(__bridge void *)self); return self->compression!=NULL; }
    NSMutableArray *children=[NSMutableArray new];
    uint32_t each=((height+count-1)/count+15)&~15u, y=0, remaining=bitrate;
    while(y<height) {
        uint32_t h=MIN(each,height-y), rate=y+h==height?remaining:(uint32_t)((uint64_t)bitrate*h/height);
        if(!rate) return false;
        RDStream *child=[RDStream new]; child->stripeY=y; child->imageWidth=width; child->imageHeight=h; child->bitrate=rate;
        child->compression=encoder(width,h,fps,rate,encoded,(__bridge void *)child);
        if(!child->compression || CVPixelBufferCreate(NULL,width,h,kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange,NULL,&child->stripeImage)) return false;
        [children addObject:child]; y+=h; remaining-=rate;
    }
    self->stripes=children; return children.count==count;
}
static int encode_image(RDStream *self,CVPixelBufferRef image,uint64_t timestamp,bool key) {
    self->packet=[NSMutableData new]; self->encodeFailed=NO; self->retryKey=NO; self->wantKey=key;
    NSDictionary *options=@{(__bridge NSString *)kVTEncodeFrameOptionKey_ForceKeyFrame:@(key)};
    OSStatus status=VTCompressionSessionEncodeFrame(self->compression,image,CMTimeMake(timestamp,1000000),kCMTimeInvalid,(__bridge CFDictionaryRef)options,NULL,NULL);
    if(!status) status=VTCompressionSessionCompleteFrames(self->compression,kCMTimeInvalid);
    if(status || self->encodeFailed) return -1;
    if(self->retryKey) return 2;
    return self->packet.length?1:-1;
}
static int encode_pipeline(RDStream *self,CVPixelBufferRef image,uint64_t timestamp,bool key,bool force) {
    if(!self->stripes) return encode_image(self,image,timestamp,key);
    self->retryKey=NO;
    if(CVPixelBufferGetPixelFormatType(image)!=kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange || CVPixelBufferGetPlaneCount(image)!=2 ||
       CVPixelBufferGetWidth(image)!=self->imageWidth || CVPixelBufferGetHeight(image)!=self->imageHeight ||
       CVPixelBufferLockBaseAddress(image,kCVPixelBufferLock_ReadOnly)) return -1;
    bool copied=true; bool activeStorage[2]={key||force,key||force}; bool *active=activeStorage; size_t stripeIndex=0;
    for(RDStream *child in self->stripes) {
        if(CVPixelBufferLockBaseAddress(child->stripeImage,0)) { copied=false; break; }
        for(size_t plane=0;plane<2;plane++) {
            size_t stride=CVPixelBufferGetBytesPerRowOfPlane(image,plane), outStride=CVPixelBufferGetBytesPerRowOfPlane(child->stripeImage,plane);
            if(stride<self->imageWidth || outStride<self->imageWidth) { copied=false; break; }
            const uint8_t *source=CVPixelBufferGetBaseAddressOfPlane(image,plane);
            uint8_t *out=CVPixelBufferGetBaseAddressOfPlane(child->stripeImage,plane);
            if(!source || !out) { copied=false; break; }
            size_t y=child->stripeY/(plane?2:1), rows=child->imageHeight/(plane?2:1);
            for(size_t row=0;row<rows;row++) {
                if(!active[stripeIndex] && memcmp(out+row*outStride,source+(row+y)*stride,self->imageWidth)) active[stripeIndex]=true;
                memcpy(out+row*outStride,source+(row+y)*stride,self->imageWidth);
            }
        }
        CVPixelBufferUnlockBaseAddress(child->stripeImage,0);
        if(!copied) break;
        stripeIndex++;
    }
    CVPixelBufferUnlockBaseAddress(image,kCVPixelBufferLock_ReadOnly);
    if(!copied) return -1;
    // Each child owns its compression session; no input/capture callbacks run here.
    int resultStorage[2]={0,0}; int *results=resultStorage;
    dispatch_apply(self->stripes.count,dispatch_get_global_queue(QOS_CLASS_USER_INITIATED,0),^(size_t i){
        if(!active[i]) return;
        RDStream *child=self->stripes[i]; results[i]=encode_image(child,child->stripeImage,timestamp,key);
    });
    for(size_t i=0;i<self->stripes.count;i++) {
        if(results[i]<0) return -1;
        if(results[i]==2) { self->retryKey=YES; return 2; }
    }
    uint8_t count=0; for(size_t i=0;i<self->stripes.count;i++) if(active[i]) count++;
    if(!count) return 0;
    uint8_t header[]={'R','S',2,count};
    self->packet=[NSMutableData dataWithBytes:header length:sizeof(header)];
    for(size_t i=0;i<self->stripes.count;i++) {
        if(!active[i]) continue;
        RDStream *child=self->stripes[i]; size_t n=child->packet.length;
        if(!n || self->packet.length+n+6>4*1024*1024) return -1;
        uint8_t record[]={(uint8_t)i,key?1:0,(uint8_t)(n>>24),(uint8_t)(n>>16),(uint8_t)(n>>8),(uint8_t)n};
        [self->packet appendBytes:record length:6]; [self->packet appendData:child->packet];
    }
    return 1;
}
// Exercises the actual two-session/copy/bundle path without SCStream or permissions.
bool rd_synthetic_stripes(uint32_t frames,RDPacket emit,void *context) {
    @autoreleasepool {
        if(!frames || frames>60) return false;
        RDStream *self=[RDStream new];
        if(!configure_pipeline(self,640,480,60,2000000,2)) return false;
        CVPixelBufferRef image=NULL;
        if(CVPixelBufferCreate(NULL,640,480,kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange,NULL,&image)) return false;
        if(CVPixelBufferLockBaseAddress(image,0)) { CVPixelBufferRelease(image); return false; }
        for(size_t y=0;y<480;y++) memset((uint8_t *)CVPixelBufferGetBaseAddressOfPlane(image,0)+y*CVPixelBufferGetBytesPerRowOfPlane(image,0),y<240?48:208,640);
        memset(CVPixelBufferGetBaseAddressOfPlane(image,1),128,CVPixelBufferGetBytesPerRowOfPlane(image,1)*240);
        CVPixelBufferUnlockBaseAddress(image,0);
        bool ok=true;
        for(uint32_t i=0;i<frames && ok;i++) {
            if(CVPixelBufferLockBaseAddress(image,0)) { ok=false; break; }
            for(size_t y=0;y<480;y++) memset((uint8_t *)CVPixelBufferGetBaseAddressOfPlane(image,0)+y*CVPixelBufferGetBytesPerRowOfPlane(image,0),y<240?48+(i/2)%2:208+((i+1)/2)%2,640);
            CVPixelBufferUnlockBaseAddress(image,0);
            ok=encode_pipeline(self,image,i*16667,i==0,false)==1;
            if(ok && emit) ok=emit(context,self->packet.bytes,self->packet.length,i*16667);
        }
        CVPixelBufferRelease(image); return ok;
    }
}
bool rd_hardware_stripes(void) { return rd_synthetic_stripes(2,NULL,NULL); }
bool rd_probe_stripe_video(uint32_t width,uint32_t height,uint32_t fps,uint32_t bitrate,uint32_t count,uint32_t *codec) {
    @autoreleasepool {
        if(!count || count>2 || !fps || fps>120) return false;
        RDStream *self=[RDStream new];
        if(!configure_pipeline(self,width,height,fps,bitrate,count)) return false;
        CVPixelBufferRef image=NULL;
        if(CVPixelBufferCreate(NULL,width,height,kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange,NULL,&image)) return false;
        if(CVPixelBufferLockBaseAddress(image,0)) { CVPixelBufferRelease(image); return false; }
        for(size_t plane=0;plane<2;plane++) memset(CVPixelBufferGetBaseAddressOfPlane(image,plane),plane?128:16,CVPixelBufferGetBytesPerRowOfPlane(image,plane)*CVPixelBufferGetHeightOfPlane(image,plane));
        CVPixelBufferUnlockBaseAddress(image,0);
        bool ok=encode_pipeline(self,image,0,true,false)==1;
        CVPixelBufferRelease(image);
        if(!ok) return false;
        uint32_t first=0;
        for(RDStream *child in self->stripes) {
            const uint8_t *bytes=child->packet.bytes;
            if(child->packet.length<8 || (bytes[4]&31)!=7) return false;
            uint32_t value=((uint32_t)bytes[5]<<16)|((uint32_t)bytes[6]<<8)|bytes[7];
            if(first && value!=first) return false; first=value;
        }
        *codec=first; return first!=0;
    }
}

static bool synthetic_frame_at(uint32_t width,uint32_t height,uint32_t fps,uint32_t bitrate,uint32_t *codec,RDPacket emit,void *context) {
    @autoreleasepool {
        RDStream *self=[RDStream new]; self->packet=[NSMutableData new];
        self->wantKey=YES; self->compression=encoder(width,height,fps,bitrate,encoded,(__bridge void *)self);
        if(!self->compression) return false;
        CVPixelBufferRef image=NULL;
        if(CVPixelBufferCreate(NULL,width,height,kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange,NULL,&image)) return false;
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
bool rd_hardware_codec(uint32_t *codec) { return synthetic_frame_at(640,480,60,2000000,codec,NULL,NULL); }
bool rd_synthetic_packet(RDPacket emit,void *context) { uint32_t codec; return synthetic_frame_at(640,480,60,2000000,&codec,emit,context); }
// Test fixture: the same hardware encoder and packet callback as live capture,
// fed only locally allocated pixels. No ScreenCaptureKit/input/permission calls.
bool rd_capture_set_bitrate(void *handle,uint32_t bitrate);
bool rd_synthetic_groups(uint32_t groupLength,RDPacket emit,void *context) {
    if(groupLength!=4 && groupLength!=60) return false;
    @autoreleasepool {
        RDStream *self=[RDStream new]; self->packet=[NSMutableData new];
        self->compression=encoder(640,480,60,2000000,encoded,(__bridge void *)self);
        if(!self->compression) return false;
        CVPixelBufferRef image=NULL;
        if(CVPixelBufferCreate(NULL,640,480,kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange,NULL,&image)) return false;
        bool ok=true;
        for(uint64_t frame=0;frame<3*groupLength && ok;frame++) {
            if(frame%groupLength==0) {
                uint32_t requested=frame==groupLength?500000:2000000;
                if(!rd_capture_set_bitrate((__bridge void *)self,requested)) { ok=false; break; }
                CFTypeRef property=NULL; int64_t actual=0;
                OSStatus result=VTSessionCopyProperty(self->compression,kVTCompressionPropertyKey_AverageBitRate,NULL,&property);
                bool verified=!result && property && CFGetTypeID(property)==CFNumberGetTypeID() && CFNumberGetValue((CFNumberRef)property,kCFNumberSInt64Type,&actual) && actual==requested;
                if(property) CFRelease(property);
                if(!verified) { ok=false; break; }
            }
            CVPixelBufferLockBaseAddress(image,0);
            for(size_t plane=0;plane<2;plane++) memset(CVPixelBufferGetBaseAddressOfPlane(image,plane),plane?128:16,CVPixelBufferGetBytesPerRowOfPlane(image,plane)*CVPixelBufferGetHeightOfPlane(image,plane));
            CVPixelBufferUnlockBaseAddress(image,0);
            self->wantKey=(frame%groupLength)==0; self->encodeFailed=NO; [self->packet setLength:0];
            NSDictionary *options=@{(__bridge NSString *)kVTEncodeFrameOptionKey_ForceKeyFrame:@(self->wantKey)};
            OSStatus status=VTCompressionSessionEncodeFrame(self->compression,image,CMTimeMake(frame,60),kCMTimeInvalid,(__bridge CFDictionaryRef)options,NULL,NULL);
            if(!status) status=VTCompressionSessionCompleteFrames(self->compression,kCMTimeInvalid);
            ok=!status && !self->encodeFailed && self->packet.length>0 && emit(context,self->packet.bytes,self->packet.length,frame*16667);
            if(!ok) fprintf(stderr,"Synthetic GOP frame %llu: status=%d encodeFailed=%d insertedKey=%d bytes=%lu\n",frame,(int)status,self->encodeFailed,self->retryKey,(unsigned long)self->packet.length);
        }
        CVPixelBufferRelease(image); return ok;
    }
}
// Called only while the Rust capture lock is held, between completed GOPs.
bool rd_capture_set_bitrate(void *handle,uint32_t bitrate) {
    RDStream *self=(__bridge RDStream *)handle;
    if(!self || !bitrate || self->bitrateUnsupported) return false;
    if(self->stripes) {
        if(bitrate<self->stripes.count) return false;
        uint32_t remaining=bitrate; bool ok=true;
        for(RDStream *child in self->stripes) {
            uint32_t rate=child->stripeY+child->imageHeight==self->imageHeight?remaining:(uint32_t)((uint64_t)bitrate*child->imageHeight/self->imageHeight);
            ok=rd_capture_set_bitrate((__bridge void *)child,rate)&&ok; remaining-=rate;
        }
        if(ok) self->bitrate=bitrate; return ok;
    }
    if(!self->compression) return false;
    if(self->bitrate==bitrate) return true;
    OSStatus status=VTSessionSetProperty(self->compression,kVTCompressionPropertyKey_AverageBitRate,(__bridge CFNumberRef)@(bitrate));
    if(status) { self->bitrateUnsupported=YES; NSLog(@"Screen encoder rejected dynamic bitrate (%d); retaining transport pacing",(int)status); return false; }
    self->bitrate=bitrate;
    return true;
}
bool rd_capture_destroy(void *handle);
// The returned object owns a bounded (latest only) frame slot and a hardware session.
void *rd_capture_create(uint32_t id,double x,double y,double w,double h,uint32_t width,uint32_t height,uint32_t fps,uint32_t bitrate,uint32_t stripes,bool *shutdown_failed) {
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
        if(!configure_pipeline(self,width,height,fps,bitrate,stripes)) return NULL;
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
int rd_capture_next(void *handle,uint64_t timestamp,bool key,bool refresh,bool *damaged,RDPacket emit,void *context) {
    @autoreleasepool {
        RDStream *self=(__bridge RDStream *)handle; CVPixelBufferRef image=NULL;
        *damaged=false;
        uint64_t until=clock_gettime_nsec_np(CLOCK_UPTIME_RAW)+20*NSEC_PER_MSEC;
        while(!image) {
            @synchronized(self) {
                if(self->stopped || !(rd_permissions() & 1)) return -1;
                if(self->latest && (self->serial!=self->consumed || refresh || self->retryKey)) { *damaged=self->serial!=self->consumed; image=CVPixelBufferRetain(self->latest); self->consumed=self->serial; }
            }
            if(image) break;
            if(clock_gettime_nsec_np(CLOCK_UPTIME_RAW)>=until) return 0;
            dispatch_semaphore_wait(self->ready,dispatch_time(DISPATCH_TIME_NOW,20*NSEC_PER_MSEC));
        }
        int result=encode_pipeline(self,image,timestamp,key,refresh);
        CVPixelBufferRelease(image);
        if(result!=1) return result;
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

// Bounded synthetic encoder validation. No display capture or input APIs are used.
bool rd_probe_video(uint32_t width,uint32_t height,uint32_t fps,uint32_t bitrate,uint32_t *codec) {
    if(width<2 || height<2 || width>4096 || height>4096 || width%2 || height%2 ||
       (uint64_t)width*height>8388608 || fps<1 || fps>120 || bitrate<1 || bitrate>100000000) return false;
    return synthetic_frame_at(width,height,fps,bitrate,codec,NULL,NULL);
}
