//! Synthetic CPU conversion only. No DXGI, screen, input, or hardware claims.
//! rustc --edition 2021 -O tools/windows-pixels-bench.rs -o /tmp/pixels-bench
#[allow(dead_code)]
#[path = "../daemon/windows/src/desktop_pixels.rs"]
mod pixels;
fn main() {
    let (w,h)=(1280,720);
    for size in [32,256,720] {
        let mut image=vec![0u8;w*h*4];
        let mut retained=pixels::nv12(&image,(w,h,w*4),(0,0,w,h),(w,h)).unwrap();
        let (mut full_ns,mut partial_ns)=(0u128,0u128);
        for n in 0..30 {
            for y in 0..size {for x in 0..size {image[(y*w+x)*4+2]=(n*7) as u8;}}
            let start=std::time::Instant::now();
            let full=pixels::nv12(&image,(w,h,w*4),(0,0,w,h),(w,h)).unwrap();
            full_ns+=start.elapsed().as_nanos();
            let start=std::time::Instant::now();
            pixels::nv12_update(&image,(w,h,w*4),(0,0,w,h),(w,h),&[(0,0,size as u32,size as u32)],&mut retained).unwrap();
            partial_ns+=start.elapsed().as_nanos();
            assert_eq!(retained,full);
        }
        println!("{{\"width\":{w},\"height\":{h},\"damage_side\":{size},\"frames\":30,\"full_mean_us\":{},\"partial_mean_us\":{}}}",full_ns/30/1000,partial_ns/30/1000);
    }
}
