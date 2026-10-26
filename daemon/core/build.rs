use std::env;
use std::path::{Path, PathBuf};
use std::process::Command;

fn main() {
    println!("cargo:rerun-if-changed=../../protocol/schemas/wire");
    println!("cargo:rerun-if-changed=../../protocol/schemas/socket-wire");
    println!("cargo:rerun-if-changed=../../protocol/schemas/rpc");
    println!("cargo:rerun-if-changed=../../protocol/schemas/ipc");
    println!("cargo:rerun-if-changed=../../scripts/codegen/rust");
    println!("cargo:rerun-if-changed=../../scripts/codegen/bdl-config.ts");
    println!("cargo:rerun-if-changed=../../bdl.yaml");
    println!("cargo:rerun-if-changed=../../package.json");
    println!("cargo:rerun-if-changed=../../pnpm-lock.yaml");

    let out_dir = PathBuf::from(env::var_os("OUT_DIR").expect("OUT_DIR must be set"));
    run_codegen(
        "../../protocol/schemas/wire",
        &out_dir.join("wire.rs"),
        &["--no-byte-codec"],
    );
    run_codegen(
        "../../protocol/schemas/socket-wire",
        &out_dir.join("socket_wire.rs"),
        &["--no-byte-codec"],
    );
    run_codegen("../../protocol/schemas/rpc", &out_dir.join("rpc.rs"), &[]);
    run_codegen("../../protocol/schemas/ipc", &out_dir.join("ipc.rs"), &[]);
}

fn run_codegen(schema: &str, out: &Path, extra_args: &[&str]) {
    let status = Command::new("node")
        .args([
            "--import",
            "tsx",
            "../../scripts/codegen/rust/main.ts",
            "--schema",
            schema,
            "--out",
        ])
        .arg(out)
        .args(extra_args)
        .status()
        .expect("failed to run Node.js for Rust protocol codegen");

    if !status.success() {
        panic!("Rust protocol codegen failed for {schema}");
    }
}
