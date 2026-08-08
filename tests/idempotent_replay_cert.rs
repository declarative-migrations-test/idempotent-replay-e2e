#![forbid(unsafe_code)]

use anyhow::{Context, Result};
use dpm::lease::{PostgresMigrationLease, ValidatedScript, DEFAULT_MIGRATION_LOCK_KEY};
use sqlx::{Connection, PgConnection};

const MIGRATION_ID: &str = "001_formal_lease";
const CHECKSUM: &str = "fnv-proof-5fd405760248";

fn test_lock_key() -> i64 {
    DEFAULT_MIGRATION_LOCK_KEY ^ 0x4944_454d_504f_5445
}

async fn ledger_count(url: &str) -> Result<i64> {
    let mut conn = PgConnection::connect(url).await?;
    let count = sqlx::query_scalar::<_, i64>(
        "SELECT count(*) FROM dpm_replay_ledger WHERE migration_id = $1",
    )
    .bind(MIGRATION_ID)
    .fetch_one(&mut conn)
    .await?;
    conn.close().await?;
    Ok(count)
}

async fn ledger_checksum(url: &str) -> Result<String> {
    let mut conn = PgConnection::connect(url).await?;
    let checksum = sqlx::query_scalar::<_, String>(
        "SELECT checksum FROM dpm_replay_ledger WHERE migration_id = $1",
    )
    .bind(MIGRATION_ID)
    .fetch_one(&mut conn)
    .await?;
    conn.close().await?;
    Ok(checksum)
}

#[tokio::test]
async fn rollback_twice_then_resume_and_replay_are_consistent() -> Result<()> {
    let url = std::env::var("DPM_TEST_DATABASE_URL")
        .context("DPM_TEST_DATABASE_URL must point at the PostgreSQL test service")?;

    let mut cleanup = PgConnection::connect(&url).await?;
    sqlx::raw_sql("DROP TABLE IF EXISTS dpm_replay_ledger")
        .execute(&mut cleanup)
        .await?;
    cleanup.close().await?;

    let key = test_lock_key();
    let mut lease = PostgresMigrationLease::acquire(&url, key, "idempotent-owner-a").await?;
    let collision = PostgresMigrationLease::acquire(&url, key, "idempotent-owner-b").await;
    assert!(
        collision.is_err(),
        "a second owner acquired the active lease"
    );

    let setup = ValidatedScript::parse(
        r#"CREATE TABLE dpm_replay_ledger (
            migration_id text PRIMARY KEY,
            checksum text NOT NULL
        );"#,
    )?;
    assert_eq!(lease.apply(&setup).await?.executed, 1);

    let failing_sql = format!(
        r#"BEGIN;
        INSERT INTO dpm_replay_ledger (migration_id, checksum)
        VALUES ('{MIGRATION_ID}', '{CHECKSUM}')
        ON CONFLICT (migration_id) DO NOTHING;
        SELECT 1 / 0;
        COMMIT;"#
    );
    let failing = ValidatedScript::parse(&failing_sql)?;

    for attempt in 1..=2 {
        assert!(
            lease.apply(&failing).await.is_err(),
            "failing migration attempt {attempt} unexpectedly succeeded"
        );
        assert_eq!(
            ledger_count(&url).await?,
            0,
            "failed attempt {attempt} leaked a ledger row"
        );
    }

    let replay_sql = format!(
        r#"BEGIN;
        INSERT INTO dpm_replay_ledger (migration_id, checksum)
        VALUES ('{MIGRATION_ID}', '{CHECKSUM}')
        ON CONFLICT (migration_id) DO NOTHING;
        COMMIT;"#
    );
    let replay = ValidatedScript::parse(&replay_sql)?;

    for pass in 1..=2 {
        assert_eq!(lease.apply(&replay).await?.executed, 3);
        assert_eq!(
            ledger_count(&url).await?,
            1,
            "successful replay pass {pass} changed ledger cardinality"
        );
    }
    assert_eq!(ledger_checksum(&url).await?, CHECKSUM);

    let receipt = lease.release().await?;
    assert_eq!(receipt.key(), key);
    assert_eq!(receipt.owner(), "idempotent-owner-a");
    assert_eq!(receipt.executed(), 7);
    assert_eq!(
        receipt.last_script_fingerprint(),
        Some(replay.fingerprint())
    );

    let second = PostgresMigrationLease::acquire(&url, key, "idempotent-owner-b").await?;
    let second_receipt = second.release().await?;
    assert_eq!(second_receipt.owner(), "idempotent-owner-b");
    assert_eq!(second_receipt.executed(), 0);

    Ok(())
}
