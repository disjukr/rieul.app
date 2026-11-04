fn main() {
    cc::Build::new()
        .file("video.m")
        .flag("-fobjc-arc")
        .compile("hardware_bench");
    for f in ["Foundation", "VideoToolbox", "CoreMedia", "CoreVideo"] {
        println!("cargo:rustc-link-lib=framework={f}");
    }
    println!("cargo:rerun-if-changed=video.m");
}
