// SYNTHETIC ENCODER ONLY: no screen, input, permission, listener or system APIs.
#import <Foundation/Foundation.h>
#import <VideoToolbox/VideoToolbox.h>
#include <stdbool.h>
typedef struct {VTCompressionSessionRef session;CVPixelBufferRef image;size_t bytes;bool failed,key;CMSampleBufferRef sample;VTDecompressionSessionRef decoder;CVPixelBufferRef decoded;} Bench;
static void packet(void *ctx,void *source,OSStatus status,VTEncodeInfoFlags flags,CMSampleBufferRef sample){
 (void)source;Bench *b=ctx;if(b->sample){CFRelease(b->sample);b->sample=NULL;}if(sample)b->sample=(CMSampleBufferRef)CFRetain(sample);if(status || !sample || (flags&kVTEncodeInfo_FrameDropped)){b->failed=true;return;}
 CFArrayRef a=CMSampleBufferGetSampleAttachmentsArray(sample,false);
 b->key=!(a && CFArrayGetCount(a) && CFDictionaryContainsKey(CFArrayGetValueAtIndex(a,0),kCMSampleAttachmentKey_NotSync));
 b->bytes=CMBlockBufferGetDataLength(CMSampleBufferGetDataBuffer(sample));
 if(b->key){size_t count=0;int size=0;CMFormatDescriptionRef f=CMSampleBufferGetFormatDescription(sample);
 if(CMVideoFormatDescriptionGetH264ParameterSetAtIndex(f,0,NULL,NULL,&count,&size)||size!=4){b->failed=true;return;}
 for(size_t i=0;i<count;i++){size_t n=0;if(CMVideoFormatDescriptionGetH264ParameterSetAtIndex(f,i,NULL,&n,NULL,NULL)){b->failed=true;return;}b->bytes+=4+n;}}
}
void bench_drop(void *p){Bench *b=p;if(!b)return;if(b->session){VTCompressionSessionInvalidate(b->session);CFRelease(b->session);}if(b->image)CFRelease(b->image);if(b->sample)CFRelease(b->sample);if(b->decoded)CFRelease(b->decoded);if(b->decoder){VTDecompressionSessionInvalidate(b->decoder);CFRelease(b->decoder);}free(b);}
void *bench_new(uint32_t w,uint32_t h,uint32_t fps,uint32_t bitrate){
 @autoreleasepool {
 Bench *b=calloc(1,sizeof(Bench));
 NSDictionary *spec=@{(__bridge NSString*)kVTVideoEncoderSpecification_RequireHardwareAcceleratedVideoEncoder:@YES};
 if(VTCompressionSessionCreate(NULL,w,h,kCMVideoCodecType_H264,(__bridge CFDictionaryRef)spec,NULL,NULL,packet,b,&b->session)){bench_drop(b);return NULL;}
 NSDictionary *props=@{(__bridge NSString*)kVTCompressionPropertyKey_RealTime:@YES,
 (__bridge NSString*)kVTCompressionPropertyKey_AllowFrameReordering:@NO,
 (__bridge NSString*)kVTCompressionPropertyKey_ProfileLevel:(__bridge NSString*)kVTProfileLevel_H264_Baseline_4_2,
 (__bridge NSString*)kVTCompressionPropertyKey_ExpectedFrameRate:@(fps),
 (__bridge NSString*)kVTCompressionPropertyKey_AverageBitRate:@(bitrate)};
 if(VTSessionSetProperties(b->session,(__bridge CFDictionaryRef)props)||VTCompressionSessionPrepareToEncodeFrames(b->session)){bench_drop(b);return NULL;}
 VTSessionSetProperty(b->session,kVTCompressionPropertyKey_MaxKeyFrameInterval,(__bridge CFNumberRef)@60);
 CFTypeRef hw=NULL;OSStatus status=VTSessionCopyProperty(b->session,kVTCompressionPropertyKey_UsingHardwareAcceleratedVideoEncoder,NULL,&hw);
 bool ok=!status&&hw==kCFBooleanTrue;if(hw)CFRelease(hw);if(!ok){bench_drop(b);return NULL;}
 if(CVPixelBufferCreate(NULL,w,h,kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange,NULL,&b->image)){bench_drop(b);return NULL;}return b;
 }
}
size_t bench_encode(void *p,const uint8_t *y,const uint8_t *uv,uint32_t w,uint32_t h,uint64_t time,bool key){
 @autoreleasepool {
 Bench *b=p;b->bytes=0;b->failed=false;
 if(CVPixelBufferLockBaseAddress(b->image,0))return 0;
 for(size_t row=0;row<h;row++)memcpy(CVPixelBufferGetBaseAddressOfPlane(b->image,0)+row*CVPixelBufferGetBytesPerRowOfPlane(b->image,0),y+row*w,w);
 for(size_t row=0;row<h/2;row++)memcpy(CVPixelBufferGetBaseAddressOfPlane(b->image,1)+row*CVPixelBufferGetBytesPerRowOfPlane(b->image,1),uv+row*w,w);
 CVPixelBufferUnlockBaseAddress(b->image,0);
 NSDictionary *options=@{(__bridge NSString*)kVTEncodeFrameOptionKey_ForceKeyFrame:@(key)};
 OSStatus status=VTCompressionSessionEncodeFrame(b->session,b->image,CMTimeMake(time,1000000),kCMTimeInvalid,(__bridge CFDictionaryRef)options,NULL,NULL);
 if(!status)status=VTCompressionSessionCompleteFrames(b->session,kCMTimeInvalid);
 return status||b->failed||b->key!=key?0:b->bytes;
 }
}

static void decoded(void *ctx,void *source,OSStatus status,VTDecodeInfoFlags flags,CVImageBufferRef image,CMTime pts,CMTime duration){
 (void)source;(void)flags;(void)pts;(void)duration;Bench *b=ctx;if(status||!image){b->failed=true;return;}if(b->decoded)CFRelease(b->decoded);b->decoded=CVPixelBufferRetain(image);
}
// Decode/quality work is timed separately from encode by the Rust driver.
double bench_mse(void *p){Bench *b=p;
 if(!b->sample)return -1;
 if(!b->decoder){VTDecompressionOutputCallbackRecord cb={decoded,b};NSDictionary *attrs=@{(__bridge NSString*)kCVPixelBufferPixelFormatTypeKey:@(kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange)};
 if(VTDecompressionSessionCreate(NULL,CMSampleBufferGetFormatDescription(b->sample),NULL,(__bridge CFDictionaryRef)attrs,&cb,&b->decoder))return -1;}
 if(VTDecompressionSessionDecodeFrame(b->decoder,b->sample,0,NULL,NULL)||VTDecompressionSessionWaitForAsynchronousFrames(b->decoder)||!b->decoded)return -1;
 if(CVPixelBufferLockBaseAddress(b->image,kCVPixelBufferLock_ReadOnly))return -1;
 if(CVPixelBufferLockBaseAddress(b->decoded,kCVPixelBufferLock_ReadOnly)){CVPixelBufferUnlockBaseAddress(b->image,kCVPixelBufferLock_ReadOnly);return -1;}
 size_t w=CVPixelBufferGetWidth(b->image),h=CVPixelBufferGetHeight(b->image);double sum=0;
 const uint8_t *a=CVPixelBufferGetBaseAddressOfPlane(b->image,0),*d=CVPixelBufferGetBaseAddressOfPlane(b->decoded,0);
 for(size_t y=0;y<h;y++)for(size_t x=0;x<w;x++){int delta=a[y*CVPixelBufferGetBytesPerRowOfPlane(b->image,0)+x]-d[y*CVPixelBufferGetBytesPerRowOfPlane(b->decoded,0)+x];sum+=(double)delta*delta;}
 CVPixelBufferUnlockBaseAddress(b->decoded,kCVPixelBufferLock_ReadOnly);CVPixelBufferUnlockBaseAddress(b->image,kCVPixelBufferLock_ReadOnly);return sum/(w*h);
}
