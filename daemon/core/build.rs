use std::env;
use std::path::{Path, PathBuf};
use std::process::Command;

fn main() {
    println!("cargo:rerun-if-changed=../../protocol/schemas/wire");
    println!("cargo:rerun-if-changed=../../protocol/schemas/socket-wire");
    println!("cargo:rerun-if-changed=../../protocol/schemas/rpc");
    println!("cargo:rerun-if-changed=../../protocol/schemas/ipc");
    println!("cargo:rerun-if-changed=../../scripts/codegen/rust");
    println!("cargo:rerun-if-changed=../../deno.json");
    println!("cargo:rerun-if-changed=../../deno.lock");

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
    let status = Command::new("deno")
        .args([
            "run",
            "-A",
            "../../scripts/codegen/rust/main.ts",
            "--schema",
            schema,
            "--out",
        ])
        .arg(out)
        .args(extra_args)
        .status()
        .expect("failed to run deno for Rust protocol codegen");

    if !status.success() {
        panic!("Rust protocol codegen failed for {schema}");
    }
}
