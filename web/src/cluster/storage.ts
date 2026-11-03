import type { ClusterHistory } from "../protocol/generated/rpc.ts";
import { hex, same, verifyHistory } from "./trust.ts";
export interface ClusterRecord {
  id: string;
  privateKey: CryptoKey;
  publicKey: Uint8Array;
  history?: ClusterHistory;
  grantId?: Uint8Array;
}
function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    let blocked = false;
    const request = indexedDB.open("rieul.cluster.v1", 1);
    request.onupgradeneeded = () =>
      request.result.createObjectStore("clusters", { keyPath: "id" });
    request.onerror = () => reject(request.error);
    request.onblocked = () => {
      blocked = true;
      reject(new Error("Cluster key storage is blocked by another tab"));
    };
    request.onsuccess = () => {
      const db = request.result;
      if (blocked) {
        db.close();
        return;
      }
      db.onversionchange = () => db.close();
      resolve(db);
    };
  });
}
// No await inside a transaction: concurrent tabs serialize get-or-add atomically.
async function transaction<T>(
  id: string,
  update: (
    current: ClusterRecord | undefined,
  ) => [ClusterRecord | undefined, T],
): Promise<T> {
  const db = await open();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction("clusters", "readwrite");
      const store = tx.objectStore("clusters");
      let result: T;
      const request = store.get(id);
      request.onsuccess = () => {
        try {
          const [next, value] = update(request.result);
          result = value;
          if (next) store.put(next);
        } catch (error) {
          tx.abort();
          reject(error);
        }
      };
      tx.oncomplete = () => resolve(result);
      tx.onabort = () =>
        reject(tx.error ?? new Error("Cluster storage transaction aborted"));
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}
function validate(record: ClusterRecord) {
  if (
    record.privateKey.type !== "private" ||
    record.privateKey.extractable ||
    record.privateKey.algorithm.name !== "Ed25519" ||
    !record.privateKey.usages.includes("sign") ||
    record.publicKey.length !== 32
  )
    throw new Error("Invalid cluster key storage");
  return record;
}
export async function readCluster(
  id: string,
): Promise<ClusterRecord | undefined> {
  return transaction(id, (current) => [
    undefined,
    current && validate(current),
  ]);
}
export async function clusterKey(id: string): Promise<ClusterRecord> {
  if (!/^[a-f0-9]{64}$/.test(id)) throw new Error("Invalid cluster ID");
  const existing = await readCluster(id);
  if (existing) return existing;
  const keys = (await crypto.subtle.generateKey("Ed25519", false, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const candidate = {
    id,
    privateKey: keys.privateKey,
    publicKey: new Uint8Array(
      await crypto.subtle.exportKey("raw", keys.publicKey),
    ),
  };
  return transaction(id, (current) =>
    current ? [undefined, validate(current)] : [candidate, candidate],
  );
}
export async function storeHistory(
  history: ClusterHistory,
  grantId?: Uint8Array,
): Promise<ClusterRecord> {
  const verified = await verifyHistory(history),
    id = hex(verified.head.clusterId);
  return transaction(id, (current) => {
    if (!current) throw new Error("Cluster key is missing");
    validate(current);
    if (current.history) {
      const old = current.history.head;
      if (old.sequence > verified.head.sequence) return [undefined, current];
      if (!same(verified.hashes[old.sequence], old.entryHash))
        throw new Error("Cluster history conflicts with saved history");
    }
    const selected = grantId ?? current.grantId;
    const grant = selected && verified.grants.get(hex(selected));
    if (
      grantId &&
      (!grant ||
        !same(grant.client, current.publicKey) ||
        grant.expires * 1000 <= Date.now())
    )
      throw new Error("Cluster grant is not valid for this browser");
    const next = { ...current, history, grantId: selected };
    return [next, next];
  });
}
// Clear only the expected grant: explicit re-pairing, or expiry while a valid
// local pairing remains. Revocation is never a periodic re-adoption trigger.
export async function resetGrantAfterPairing(
  id: string,
  expected: Uint8Array,
): Promise<void> {
  await transaction(id, (current) => [
    current?.grantId && same(current.grantId, expected)
      ? { ...current, grantId: undefined }
      : undefined,
    undefined,
  ]);
}
