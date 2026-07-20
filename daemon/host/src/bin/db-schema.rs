use std::env;
use std::fs;
use std::path::{Path, PathBuf};

use anyhow::{bail, ensure, Context, Result};
use rusqlite::Connection;

#[path = "../db_schema.rs"]
mod db_schema;

use db_schema::{MIGRATIONS, SCHEMA_VERSION};

fn main() {
    if let Err(error) = run() {
        eprintln!("db-schema: {error:#}");
        std::process::exit(1);
    }
}

fn run() -> Result<()> {
    let mut args = env::args().skip(1);
    let command = args.next();
    if args.next().is_some() {
        bail!("usage: db-schema <generate|check>");
    }

    let root = workspace_root();
    validate_migration_files(&root)?;
    let generated = generate_current_schema()?;
    let output_path = root.join("daemon/db-schema/current.sql");

    match command.as_deref() {
        Some("generate") => {
            fs::write(&output_path, generated)
                .with_context(|| format!("write {}", output_path.display()))?;
            println!("generated {}", output_path.display());
        }
        Some("check") => {
            let current = fs::read_to_string(&output_path)
                .with_context(|| format!("read {}", output_path.display()))?;
            ensure!(
                current == generated,
                "{} is stale; run `deno task db-schema:generate`",
                output_path.display()
            );
            println!("{} is up to date", output_path.display());
        }
        _ => bail!("usage: db-schema <generate|check>"),
    }

    Ok(())
}

fn workspace_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(|path| path.parent())
        .expect("daemon/host must be inside the workspace root")
        .to_path_buf()
}

fn validate_migration_files(root: &Path) -> Result<()> {
    let migrations_dir = root.join("daemon/db-schema/migrations");
    let mut actual = fs::read_dir(&migrations_dir)
        .with_context(|| format!("read {}", migrations_dir.display()))?
        .map(|entry| {
            let entry = entry?;
            let file_type = entry.file_type()?;
            Ok((entry.file_name(), file_type.is_file()))
        })
        .collect::<std::io::Result<Vec<_>>>()?
        .into_iter()
        .filter_map(|(name, is_file)| {
            let name = name.into_string().ok()?;
            (is_file && name.ends_with(".sql")).then_some(name)
        })
        .collect::<Vec<_>>();
    actual.sort();

    let expected = MIGRATIONS
        .iter()
        .map(|migration| migration.name.to_string())
        .collect::<Vec<_>>();
    ensure!(
        actual == expected,
        "migration registration does not match SQL files\nregistered: {expected:?}\nfiles: {actual:?}"
    );

    for (index, migration) in MIGRATIONS.iter().enumerate() {
        let prefix = format!("{:04}-", index + 1);
        ensure!(
            migration.name.starts_with(&prefix),
            "migration {} must start with {prefix}",
            migration.name
        );
    }

    Ok(())
}

fn generate_current_schema() -> Result<String> {
    let mut connection =
        Connection::open_in_memory().context("open temporary daemon state database")?;
    let tx = connection
        .transaction()
        .context("start temporary schema migration")?;
    for migration in MIGRATIONS {
        tx.execute_batch(migration.sql)
            .with_context(|| format!("apply migration {}", migration.name))?;
    }
    tx.pragma_update(None, "user_version", SCHEMA_VERSION)
        .context("set temporary schema version")?;
    tx.commit().context("commit temporary schema migration")?;

    let mut statement = connection
        .prepare(
            "SELECT sql
             FROM sqlite_schema
             WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%'
             ORDER BY rowid",
        )
        .context("prepare current schema query")?;
    let definitions = statement
        .query_map([], |row| row.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()
        .context("read current schema")?;

    let mut output = format!(
        "-- GENERATED FILE. DO NOT EDIT.\n\
         -- Source of truth: migrations/*.sql\n\
         -- Regenerate with: deno task db-schema:generate\n\
         -- Schema version: {SCHEMA_VERSION}\n\n"
    );
    for definition in definitions {
        let definition = definition.trim();
        output.push_str(definition);
        if !definition.ends_with(';') {
            output.push(';');
        }
        output.push_str("\n\n");
    }
    output.push_str(&format!("PRAGMA user_version = {SCHEMA_VERSION};\n"));

    Ok(output)
}
