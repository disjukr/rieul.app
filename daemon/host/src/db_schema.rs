pub(crate) struct Migration {
    pub name: &'static str,
    pub sql: &'static str,
}

pub(crate) const MIGRATIONS: &[Migration] = &[
    Migration {
        name: "0001-initial.sql",
        sql: include_str!("../../db-schema/migrations/0001-initial.sql"),
    },
    Migration {
        name: "0002-agent-state.sql",
        sql: include_str!("../../db-schema/migrations/0002-agent-state.sql"),
    },
];

pub(crate) const SCHEMA_VERSION: i32 = MIGRATIONS.len() as i32;
