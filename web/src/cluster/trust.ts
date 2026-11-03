import { encodeCbor, type CborValue } from "../protocol/cbor.ts";
import type {
  ClusterHistory,
  ClusterJoinConsent,
  ClusterHead,
  ClusterMember,
  AuthenticateClusterClientReq,
  ClusterClientAdoptionChallenge,
} from "../protocol/generated/rpc.ts";
export const hex = (bytes: Uint8Array) =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
export const same = (a: Uint8Array, b: Uint8Array) => hex(a) === hex(b);
const fail = (): never => {
  throw new Error("Invalid cluster identity or signed history");
};
const id = (b: Uint8Array) => {
  if (!(b instanceof Uint8Array) || b.length !== 32) fail();
  return b;
};
const count = (n: number) => {
  if (!Number.isSafeInteger(n) || n < 0) fail();
  return n;
};
const bytes = (v: Uint8Array) => new Uint8Array(v);
export async function hash(v: CborValue): Promise<Uint8Array> {
  return new Uint8Array(
    await crypto.subtle.digest("SHA-256", bytes(encodeCbor(v))),
  );
}
export async function verify(
  key: Uint8Array,
  body: CborValue,
  signature: Uint8Array,
) {
  if (signature.length !== 64) fail();
  const imported = await crypto.subtle.importKey(
    "raw",
    bytes(id(key)),
    "Ed25519",
    false,
    ["verify"],
  );
  if (
    !(await crypto.subtle.verify(
      "Ed25519",
      imported,
      bytes(signature),
      bytes(encodeCbor(body)),
    ))
  )
    fail();
}
export async function sign(key: CryptoKey, body: CborValue) {
  return new Uint8Array(
    await crypto.subtle.sign("Ed25519", key, bytes(encodeCbor(body))),
  );
}
export function endpoint(raw: string): string {
  const url = new URL(raw);
  if (
    new TextEncoder().encode(raw).length > 2048 ||
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/rieul/rpc"
  )
    fail();
  return url.origin;
}
export function adoptionBody(c: ClusterClientAdoptionChallenge): CborValue[] {
  return [
    "rieul.cluster.client-possession.v1",
    id(c.clusterId),
    id(c.grantId),
    id(c.issuerAdmissionId),
    id(c.clientPublicKey),
    count(c.expiresAtUnix),
  ];
}
export function sessionBody(r: AuthenticateClusterClientReq): CborValue[] {
  const h = r.knownHead;
  return [
    "rieul.cluster.client-session.v1",
    id(h.clusterId),
    count(h.managementEpoch),
    count(h.sequence),
    id(h.entryHash),
    id(h.primaryAdmissionId),
    id(r.serverAdmissionId),
    id(r.serverPublicKey),
    id(r.grantId),
    id(r.clientPublicKey),
    id(r.nonce),
    count(r.connectionId),
  ];
}
export interface VerifiedCluster {
  head: ClusterHead;
  members: Map<string, ClusterMember>;
  grants: Map<
    string,
    { client: Uint8Array; expires: number; issuer: Uint8Array }
  >;
  hashes: Uint8Array[];
}
function mutation(raw: Uint8Array): CborValue[] {
  const b = (start: number, end: number) => raw.slice(start, end);
  const n = (start: number) => {
    const value = new DataView(
      raw.buffer,
      raw.byteOffset,
      raw.byteLength,
    ).getBigUint64(start);
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) fail();
    return Number(value);
  };
  switch (raw[0]) {
    case 0:
      if (raw.length < 98 || raw.length > 2145) fail();
      return [
        0,
        b(1, 33),
        b(33, 65),
        b(65, 97),
        new TextDecoder("utf-8", { fatal: true }).decode(b(97, raw.length)),
      ];
    case 1:
    case 4:
      if (raw.length !== 33) fail();
      return [raw[0], b(1, 33)];
    case 2:
      if (raw.length !== 169) fail();
      return [2, b(1, 33), b(33, 65), n(65), b(73, 105), b(105, 169)];
    case 3:
      if (raw.length !== 233) fail();
      return [
        3,
        b(1, 33),
        b(33, 65),
        b(65, 97),
        n(97),
        b(105, 169),
        b(169, 233),
      ];
    default:
      return fail();
  }
}
export async function verifyHistory(
  history: ClusterHistory,
  pinned?: ClusterHistory,
): Promise<VerifiedCluster> {
  if (
    history.entries.length > 512 ||
    history.entries.reduce((n, e) => n + e.mutation.length + 256, 0) >
      512 * 1024
  )
    fail();
  const g = history.genesis;
  endpoint(g.rootEndpoint);
  const cluster = await hash([
    "rieul.cluster.genesis.v1",
    id(g.nonce),
    id(g.rootAdmissionId),
    id(g.rootPublicKey),
    g.rootEndpoint,
  ]);
  const members = new Map<string, ClusterMember>([
    [
      hex(g.rootAdmissionId),
      {
        admissionId: g.rootAdmissionId,
        nodePublicKey: g.rootPublicKey,
        endpoint: g.rootEndpoint,
      },
    ],
  ]);
  const grants = new Map<
    string,
    { client: Uint8Array; expires: number; issuer: Uint8Array }
  >();
  const seen = new Set([hex(g.rootAdmissionId)]),
    revoked = new Set<string>(),
    operations = new Set<string>();
  let primary = g.rootAdmissionId,
    epoch = 1,
    sequence = 0,
    previous = cluster;
  const hashes = [cluster];
  for (const e of history.entries) {
    if (
      !same(id(e.clusterId), cluster) ||
      e.managementEpoch !== epoch ||
      e.sequence !== sequence + 1 ||
      !same(id(e.previousHash), previous) ||
      operations.has(hex(id(e.operationId)))
    )
      fail();
    const m = mutation(e.mutation);
    const request = await hash([
      "rieul.cluster.management-request.v1",
      cluster,
      epoch,
      e.operationId,
      m,
    ]);
    if (!same(request, id(e.requestHash))) fail();
    const body: CborValue[] = [
      "rieul.cluster.management.v1",
      cluster,
      epoch,
      e.sequence,
      previous,
      e.operationId,
      request,
      m,
    ];
    const issuer = members.get(hex(primary)) ?? fail();
    await verify(issuer.nodePublicKey, body, e.signature);
    const target = m[1] as Uint8Array,
      key = m[2] as Uint8Array;
    switch (m[0]) {
      case 0: {
        const address = m[4] as string;
        endpoint(address);
        if (
          seen.has(hex(target)) ||
          Array.from(members.values()).some((x) => same(x.nodePublicKey, key))
        )
          fail();
        members.set(hex(target), {
          admissionId: target,
          nodePublicKey: key,
          endpoint: address,
        });
        seen.add(hex(target));
        break;
      }
      case 1:
        if (same(target, primary)) fail();
        members.delete(hex(target));
        seen.add(hex(target));
        break;
      case 2:
        if (
          same(target, primary) ||
          !same(
            members.get(hex(target))?.nodePublicKey ?? new Uint8Array(),
            key,
          ) ||
          m[3] !== sequence ||
          !same(m[4] as Uint8Array, previous)
        )
          fail();
        await verify(
          key,
          [
            "rieul.cluster.transfer-acceptance.v1",
            cluster,
            epoch,
            epoch + 1,
            e.operationId,
            target,
            key,
            sequence,
            previous,
          ],
          m[5] as Uint8Array,
        );
        primary = target;
        epoch = count(epoch + 1);
        break;
      case 3: {
        if (grants.has(hex(target)) || revoked.has(hex(target))) fail();
        const member = members.get(hex(key)) ?? fail();
        const client = m[3] as Uint8Array,
          expires = m[4] as number,
          proof = m[5] as Uint8Array;
        const possession = adoptionBody({
          clusterId: cluster,
          grantId: target,
          issuerAdmissionId: key,
          clientPublicKey: client,
          expiresAtUnix: expires,
        });
        await verify(client, possession, proof);
        await verify(
          member.nodePublicKey,
          ["rieul.cluster.pairing-adoption.v1", encodeCbor(possession), proof],
          m[6] as Uint8Array,
        );
        grants.set(hex(target), { client, expires, issuer: key });
        break;
      }
      case 4:
        revoked.add(hex(target));
        grants.delete(hex(target));
        break;
    }
    previous = await hash([encodeCbor(body), e.signature]);
    sequence = e.sequence;
    hashes.push(previous);
    operations.add(hex(e.operationId));
  }
  const head = {
    clusterId: cluster,
    managementEpoch: epoch,
    sequence,
    entryHash: previous,
    primaryAdmissionId: primary,
  };
  if (!equalHead(head, history.head)) fail();
  if (pinned) {
    const known = await verifyHistory(pinned);
    if (
      !same(known.head.clusterId, cluster) ||
      known.head.sequence > sequence ||
      !same(hashes[known.head.sequence], known.head.entryHash)
    )
      fail();
  }
  return { head, members, grants, hashes };
}
export function equalHead(a: ClusterHead, b: ClusterHead) {
  return (
    a.managementEpoch === b.managementEpoch &&
    a.sequence === b.sequence &&
    same(a.clusterId, b.clusterId) &&
    same(a.entryHash, b.entryHash) &&
    same(a.primaryAdmissionId, b.primaryAdmissionId)
  );
}

/** Verified exact evidence permits recovery without changing a request's epoch. */
export async function hasAdmission(
  history: ClusterHistory,
  consent: ClusterJoinConsent,
) {
  const verified = await verifyHistory(history);
  if (!verified.members.has(hex(consent.admissionId))) return false;
  const digest = await hash([
    encodeCbor([
      "rieul.cluster.target-consent.v2",
      verified.head.clusterId,
      consent.operationId,
      consent.admissionId,
      consent.nodePublicKey,
      true,
      consent.endpoint,
      consent.expiresAtUnix,
    ]),
    consent.signature,
  ]);
  return history.entries.some((entry) => {
    const value = mutation(entry.mutation);
    return (
      value[0] === 0 &&
      same(value[1] as Uint8Array, consent.admissionId) &&
      same(value[2] as Uint8Array, consent.nodePublicKey) &&
      same(value[3] as Uint8Array, digest) &&
      value[4] === consent.endpoint
    );
  });
}
export async function hasRemoval(
  history: ClusterHistory,
  admissionId: Uint8Array,
) {
  await verifyHistory(history);
  return history.entries.some(
    (entry) =>
      entry.mutation[0] === 1 && same(entry.mutation.slice(1), admissionId),
  );
}
