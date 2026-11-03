import { encodeCbor, type CborValue } from "../../src/protocol/cbor.ts";
import {
  hash,
  sign,
  hex,
  verifyHistory,
  adoptionBody,
  sessionBody,
} from "../../src/cluster/trust.ts";
import type {
  ClusterHistory,
  ClusterJournalEntry,
} from "../../src/protocol/generated/rpc.ts";
export const id = (n: number) => new Uint8Array(32).fill(n);
export const concat = (...parts: Uint8Array[]) =>
  Uint8Array.from(parts.flatMap((p) => Array.from(p)));
export const u64 = (n: number) => {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setBigUint64(0, BigInt(n));
  return bytes;
};
async function keys() {
  const pair = (await crypto.subtle.generateKey("Ed25519", false, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  return {
    private: pair.privateKey,
    public: new Uint8Array(
      await crypto.subtle.exportKey("raw", pair.publicKey),
    ),
  };
}
export async function fixture() {
  const root = await keys(),
    member = await keys(),
    client = await keys();
  const genesis = {
    nonce: id(1),
    rootAdmissionId: id(2),
    rootPublicKey: root.public,
    rootEndpoint: "https://root.test/rieul/rpc",
  };
  const clusterId = await hash([
    "rieul.cluster.genesis.v1",
    genesis.nonce,
    genesis.rootAdmissionId,
    root.public,
    genesis.rootEndpoint,
  ]);
  let history: ClusterHistory = {
    genesis,
    entries: [],
    head: {
      clusterId,
      managementEpoch: 1,
      sequence: 0,
      entryHash: clusterId,
      primaryAdmissionId: id(2),
    },
  };
  let operation = 10;
  async function append(
    values: CborValue[],
    mutation: Uint8Array,
    signer = root.private,
    explicitOperation?: Uint8Array,
  ) {
    const h = history.head,
      operationId = explicitOperation ?? id(operation++);
    const requestHash = await hash([
      "rieul.cluster.management-request.v1",
      clusterId,
      h.managementEpoch,
      operationId,
      values,
    ]);
    const body: CborValue[] = [
      "rieul.cluster.management.v1",
      clusterId,
      h.managementEpoch,
      h.sequence + 1,
      h.entryHash,
      operationId,
      requestHash,
      values,
    ];
    const signature = await sign(signer, body);
    const entry: ClusterJournalEntry = {
      clusterId,
      managementEpoch: h.managementEpoch,
      sequence: h.sequence + 1,
      previousHash: h.entryHash,
      operationId,
      requestHash,
      mutation,
      signature,
    };
    history = {
      genesis,
      entries: [...history.entries, entry],
      head: {
        ...h,
        sequence: entry.sequence,
        ...(values[0] === 2
          ? {
              managementEpoch: h.managementEpoch + 1,
              primaryAdmissionId: values[1] as Uint8Array,
            }
          : {}),
        entryHash: await hash([encodeCbor(body), signature]),
      },
    };
    return history;
  }
  async function admit(admission = id(3)) {
    const address = "https://member.test/rieul/rpc";
    return append(
      [0, admission, member.public, id(4), address],
      concat(
        new Uint8Array([0]),
        admission,
        member.public,
        id(4),
        new TextEncoder().encode(address),
      ),
    );
  }
  async function adopt(expires = 2_000_000_000) {
    const possession = adoptionBody({
      clusterId,
      grantId: id(5),
      issuerAdmissionId: id(3),
      clientPublicKey: client.public,
      expiresAtUnix: expires,
    });
    const proof = await sign(client.private, possession);
    const issuerProof = await sign(member.private, [
      "rieul.cluster.pairing-adoption.v1",
      encodeCbor(possession),
      proof,
    ]);
    return append(
      [3, id(5), id(3), client.public, expires, proof, issuerProof],
      concat(
        new Uint8Array([3]),
        id(5),
        id(3),
        client.public,
        u64(expires),
        proof,
        issuerProof,
      ),
    );
  }
  return {
    root,
    member,
    client,
    append,
    admit,
    adopt,
    get history() {
      return history;
    },
  };
}
