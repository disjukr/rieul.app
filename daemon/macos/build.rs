fn main() {
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("macos") {
        return;
    }
    cc::Build::new()
        .file("native/desktop.m")
        .flag("-fobjc-arc")
        .flag("-mmacosx-version-min=13.0")
        .compile("rieul_desktop");
    for framework in [
        "Foundation",
        "Security",
        "AppKit",
        "CoreGraphics",
        "CoreMedia",
        "CoreVideo",
        "ScreenCaptureKit",
        "VideoToolbox",
        "ApplicationServices",
    ] {
        println!("cargo:rustc-link-lib=framework={framework}");
    }
    println!("cargo:rerun-if-changed=native/desktop.m");
}
