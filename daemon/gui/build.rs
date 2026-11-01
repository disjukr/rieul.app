fn main() {
    if std::env::var_os("CARGO_FEATURE_NATIVE").is_some()
        && std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos")
    {
        println!("cargo:rerun-if-changed=../../pairing/native/macos.m");
        cc::Build::new()
            .file("../../pairing/native/macos.m")
            .flag("-fobjc-arc")
            .flag("-std=c11")
            .flag("-mmacosx-version-min=13.0")
            .compile("rieul_gui_appkit");
        println!("cargo:rustc-link-lib=framework=Cocoa");
        println!("cargo:rustc-link-lib=framework=UserNotifications");
    }
}
