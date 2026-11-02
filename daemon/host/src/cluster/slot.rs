//! An isolated SQLite model, not the production state database or an admission verifier.
use super::proof::{ClusterId, Incarnation, JoinId};
use rusqlite::{Connection, OptionalExtension, Transaction, TransactionBehavior, params};
use std::{path::Path, time::Duration};

#[derive(Clone, Debug, PartialEq, Eq)]
struct Request {
    operation: JoinId,
    cluster: ClusterId,
    incarnation: Incarnation,
    request_hash: [u8; 32],
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Outcome {
    Reserved,
    Active,
    Retired,
}
impl Outcome {
    fn parse(value: i64) -> Result<Self, Error> {
        match value {
            1 => Ok(Self::Reserved),
            2 => Ok(Self::Active),
            3 => Ok(Self::Retired),
            _ => Err(Error::Corrupt),
        }
    }
}
#[derive(Debug)]
enum Error {
    Database(rusqlite::Error),
    Busy,
    Conflict,
    Retired,
    Stale,
    Corrupt,
    Exhausted,
}
impl From<rusqlite::Error> for Error {
    fn from(e: rusqlite::Error) -> Self {
        Self::Database(e)
    }
}
struct Store(Connection);
impl Store {
    fn open(path: &Path) -> Result<Self, Error> {
        let db = Connection::open(path)?;
        db.busy_timeout(Duration::from_secs(5))?;
        db.execute_batch("PRAGMA synchronous=FULL;
            CREATE TABLE IF NOT EXISTS slot (id INTEGER PRIMARY KEY CHECK(id=1), generation INTEGER NOT NULL CHECK(generation>=0), operation BLOB);
            INSERT OR IGNORE INTO slot VALUES(1,0,NULL);
            CREATE TABLE IF NOT EXISTS receipts (operation BLOB PRIMARY KEY CHECK(length(operation)=32), cluster BLOB NOT NULL CHECK(length(cluster)=32), incarnation BLOB NOT NULL CHECK(length(incarnation)=32), request_hash BLOB NOT NULL CHECK(length(request_hash)=32), outcome INTEGER NOT NULL CHECK(outcome IN (1,2,3)));
            CREATE TABLE IF NOT EXISTS retired (cluster BLOB NOT NULL, incarnation BLOB NOT NULL, PRIMARY KEY(cluster,incarnation));")?;
        Ok(Self(db))
    }
    fn reserve(&mut self, request: &Request) -> Result<Outcome, Error> {
        let tx = self
            .0
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let result = reserve(&tx, request)?;
        tx.commit()?;
        Ok(result)
    }
    /// Models the local commit AFTER an as-yet unspecified admission validator.
    /// This method must never become an authorization entry point by itself.
    fn activate_after_validation(&mut self, request: &Request) -> Result<Outcome, Error> {
        let tx = self
            .0
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let result = activate(&tx, request)?;
        tx.commit()?;
        Ok(result)
    }
    fn retire(&mut self, request: &Request) -> Result<Outcome, Error> {
        let tx = self
            .0
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let result = match receipt(&tx, request)? {
            Some(Outcome::Retired) => Outcome::Retired,
            Some(_) => {
                require_current(&tx, request)?;
                advance(&tx)?;
                tx.execute(
                    "INSERT OR IGNORE INTO retired VALUES(?1,?2)",
                    params![request.cluster.0, request.incarnation.0],
                )?;
                tx.execute(
                    "UPDATE receipts SET outcome=3 WHERE operation=?1",
                    params![request.operation.0],
                )?;
                tx.execute("UPDATE slot SET operation=NULL WHERE id=1", [])?;
                Outcome::Retired
            }
            None => return Err(Error::Stale),
        };
        tx.commit()?;
        Ok(result)
    }
    fn snapshot(&self) -> Result<(i64, Option<Vec<u8>>), Error> {
        Ok(self.0.query_row(
            "SELECT generation,operation FROM slot WHERE id=1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?)
    }
}
fn receipt(tx: &Transaction<'_>, request: &Request) -> Result<Option<Outcome>, Error> {
    let row = tx
        .query_row(
            "SELECT cluster,incarnation,request_hash,outcome FROM receipts WHERE operation=?1",
            params![request.operation.0],
            |r| {
                Ok((
                    r.get::<_, Vec<u8>>(0)?,
                    r.get::<_, Vec<u8>>(1)?,
                    r.get::<_, Vec<u8>>(2)?,
                    r.get::<_, i64>(3)?,
                ))
            },
        )
        .optional()?;
    match row {
        None => Ok(None),
        Some((cluster, incarnation, hash, outcome)) => {
            if cluster != request.cluster.0
                || incarnation != request.incarnation.0
                || hash != request.request_hash
            {
                return Err(Error::Conflict);
            }
            Ok(Some(Outcome::parse(outcome)?))
        }
    }
}
fn advance(tx: &Transaction<'_>) -> Result<(), Error> {
    let generation: i64 =
        tx.query_row("SELECT generation FROM slot WHERE id=1", [], |r| r.get(0))?;
    let next = generation.checked_add(1).ok_or(Error::Exhausted)?;
    tx.execute("UPDATE slot SET generation=?1 WHERE id=1", [next])?;
    Ok(())
}
fn require_current(tx: &Transaction<'_>, request: &Request) -> Result<(), Error> {
    let operation: Option<Vec<u8>> =
        tx.query_row("SELECT operation FROM slot WHERE id=1", [], |r| r.get(0))?;
    if operation.as_deref() != Some(request.operation.0.as_slice()) {
        return Err(Error::Stale);
    }
    Ok(())
}
fn reserve(tx: &Transaction<'_>, request: &Request) -> Result<Outcome, Error> {
    if let Some(outcome) = receipt(tx, request)? {
        return Ok(outcome);
    }
    let retired: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM retired WHERE cluster=?1 AND incarnation=?2)",
        params![request.cluster.0, request.incarnation.0],
        |r| r.get(0),
    )?;
    if retired {
        return Err(Error::Retired);
    }
    let occupied: bool = tx.query_row(
        "SELECT operation IS NOT NULL FROM slot WHERE id=1",
        [],
        |r| r.get(0),
    )?;
    if occupied {
        return Err(Error::Busy);
    }
    advance(tx)?;
    tx.execute(
        "INSERT INTO receipts VALUES(?1,?2,?3,?4,1)",
        params![
            request.operation.0,
            request.cluster.0,
            request.incarnation.0,
            request.request_hash
        ],
    )?;
    tx.execute(
        "UPDATE slot SET operation=?1 WHERE id=1",
        params![request.operation.0],
    )?;
    Ok(Outcome::Reserved)
}
fn activate(tx: &Transaction<'_>, request: &Request) -> Result<Outcome, Error> {
    match receipt(tx, request)? {
        Some(Outcome::Retired) => return Err(Error::Retired),
        None => return Err(Error::Stale),
        Some(Outcome::Active) => {
            require_current(tx, request)?;
            return Ok(Outcome::Active);
        }
        Some(Outcome::Reserved) => {}
    }
    require_current(tx, request)?;
    advance(tx)?;
    tx.execute(
        "UPDATE receipts SET outcome=2 WHERE operation=?1",
        params![request.operation.0],
    )?;
    Ok(Outcome::Active)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn request(n: u8) -> Request {
        Request {
            operation: JoinId([n; 32]),
            cluster: ClusterId([n; 32]),
            incarnation: Incarnation([n; 32]),
            request_hash: [n; 32],
        }
    }
    #[test]
    fn restart_retry_conflict_and_retirement_are_durable() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("isolated.sqlite");
        let a = request(1);
        let mut store = Store::open(&path).unwrap();
        assert_eq!(store.reserve(&a).unwrap(), Outcome::Reserved);
        drop(store);
        let mut store = Store::open(&path).unwrap();
        assert_eq!(store.reserve(&a).unwrap(), Outcome::Reserved);
        let mut conflict = a.clone();
        conflict.request_hash[0] ^= 1;
        assert!(matches!(store.reserve(&conflict), Err(Error::Conflict)));
        assert_eq!(
            store.activate_after_validation(&a).unwrap(),
            Outcome::Active
        );
        drop(store);
        let mut store = Store::open(&path).unwrap();
        assert_eq!(
            store.activate_after_validation(&a).unwrap(),
            Outcome::Active
        );
        assert_eq!(store.retire(&a).unwrap(), Outcome::Retired);
        drop(store);
        let mut store = Store::open(&path).unwrap();
        assert_eq!(store.reserve(&a).unwrap(), Outcome::Retired);
        assert!(matches!(
            store.activate_after_validation(&a),
            Err(Error::Retired)
        ));
        let mut reused = a.clone();
        reused.operation = JoinId([2; 32]);
        assert!(matches!(store.reserve(&reused), Err(Error::Retired)));
        reused.incarnation = Incarnation([2; 32]);
        store.reserve(&reused).unwrap();
        let snapshot = store.snapshot().unwrap();
        store.retire(&a).unwrap();
        assert_eq!(store.snapshot().unwrap(), snapshot);
        assert!(matches!(
            store.activate_after_validation(&a),
            Err(Error::Retired)
        ));
        assert_eq!(
            store.activate_after_validation(&reused).unwrap(),
            Outcome::Active
        );
    }
    #[test]
    fn interrupted_reservation_and_activation_roll_back_and_cancelled_join_cannot_finish() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("isolated.sqlite");
        let a = request(1);
        let mut store = Store::open(&path).unwrap();
        {
            let tx = store.0.transaction().unwrap();
            reserve(&tx, &a).unwrap();
        }
        drop(store);
        let mut store = Store::open(&path).unwrap();
        assert_eq!(store.snapshot().unwrap(), (0, None));
        assert!(matches!(
            store.activate_after_validation(&a),
            Err(Error::Stale)
        ));
        store.reserve(&a).unwrap();
        {
            let tx = store.0.transaction().unwrap();
            activate(&tx, &a).unwrap();
        }
        drop(store);
        let mut store = Store::open(&path).unwrap();
        assert_eq!(store.reserve(&a).unwrap(), Outcome::Reserved);
        store.retire(&a).unwrap();
        store.reserve(&request(2)).unwrap();
        assert!(matches!(
            store.activate_after_validation(&a),
            Err(Error::Retired)
        ));
        assert_eq!(store.snapshot().unwrap(), (3, Some(vec![2; 32])));
    }
    #[test]
    fn concurrent_clusters_cannot_both_reserve() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("isolated.sqlite");
        let mut a = Store::open(&path).unwrap();
        let mut b = Store::open(&path).unwrap();
        let barrier = std::sync::Barrier::new(2);
        let results = std::thread::scope(|s| {
            let x = s.spawn(|| {
                barrier.wait();
                a.reserve(&request(1))
            });
            let y = s.spawn(|| {
                barrier.wait();
                b.reserve(&request(2))
            });
            [x.join().unwrap(), y.join().unwrap()]
        });
        assert_eq!(
            results
                .iter()
                .filter(|r| matches!(r, Ok(Outcome::Reserved)))
                .count(),
            1
        );
        assert_eq!(
            results
                .iter()
                .filter(|r| matches!(r, Err(Error::Busy)))
                .count(),
            1
        );
        assert_eq!(a.snapshot().unwrap(), b.snapshot().unwrap());
        assert_eq!(a.snapshot().unwrap().0, 1);
    }
    #[test]
    fn generation_exhaustion_is_atomic_and_database_errors_remain_errors() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("isolated.sqlite");
        let mut store = Store::open(&path).unwrap();
        store
            .0
            .execute("UPDATE slot SET generation=?1", [i64::MAX])
            .unwrap();
        assert!(matches!(store.reserve(&request(1)), Err(Error::Exhausted)));
        assert_eq!(store.snapshot().unwrap(), (i64::MAX, None));
        match Store::open(dir.path()) {
            Err(Error::Database(error)) => assert!(!error.to_string().is_empty()),
            _ => panic!("expected database failure"),
        }
    }
}
