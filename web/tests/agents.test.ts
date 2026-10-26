import { test } from "node:test";
import { bunja, createBunjaStore, createReadScopeFn } from "bunja";
import { atom, createStore } from "jotai";
import { JotaiStoreScope } from "unsaturated/store";
import { createAgentsBunja } from "../src/state/agents-model.ts";
import { machineBunja, machineStoreBunja } from "../src/state/machine-store.ts";
import { MachineIdScope } from "../src/state/machine-scopes.ts";
import { MachineStorageScope } from "../src/state/machine-storage.ts";
import type {
  AgentProjectInfo,
  AgentProjectsTableEvent,
  AgentProvidersTableEvent,
  AgentSessionInfo,
  ListAgentSessionsRes,
} from "../src/protocol/generated/rpc.ts";

function assert(value: unknown, message = "assertion failed"): void {
  if (!value) throw new Error(message);
}
function deferred<T>() {
  return Promise.withResolvers<T>();
}
async function flush() {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}
function stream<T>() {
  let next = deferred<IteratorResult<T>>();
  let returns = 0;
  const iterator = {
    next: () => next.promise,
    return: () => {
      returns++;
      next.resolve({ done: true, value: undefined });
      return Promise.resolve({ done: true as const, value: undefined });
    },
    throw: (error: unknown) => Promise.reject(error),
    [Symbol.asyncDispose]() {
      return Promise.resolve();
    },
    [Symbol.asyncIterator]() {
      return this;
    },
  } as AsyncGenerator<T>;
  return {
    iterator,
    returns: () => returns,
    send(value: T) {
      const old = next;
      next = deferred();
      old.resolve({ done: false, value });
    },
  };
}
const project: AgentProjectInfo = {
  projectId: "old",
  title: "Old",
  rootPath: "/old",
  availability: 1,
  createdAtMs: 1,
};
function fixture() {
  const state = createStore();
  const store = createBunjaStore();
  const machines = ["a", "b"].map((id) => ({
    id,
    name: id,
    baseUrl: `https://${id}.example:9012`,
    clientId: id,
    clientSecret: "secret",
  }));
  const storage = {
    getItem: (key: string) =>
      key === "rieul.machines.v1" ? JSON.stringify(machines) : "a",
    setItem() {},
    removeItem() {},
  };
  const read = (id = "a") =>
    createReadScopeFn([
      [JotaiStoreScope, state],
      [MachineStorageScope, storage],
      [MachineIdScope, id],
    ], () => {
      throw new Error("unexpected scope");
    });
  const requests: ReturnType<typeof deferred<ListAgentSessionsRes>>[] = [];
  const creations: ReturnType<typeof deferred<AgentProjectInfo>>[] = [];
  const sessionCreations: ReturnType<typeof deferred<AgentSessionInfo>>[] = [];
  const archives: ReturnType<typeof deferred<AgentSessionInfo>>[] = [];
  const providers: ReturnType<typeof stream<AgentProvidersTableEvent>>[] = [];
  const projects: ReturnType<typeof stream<AgentProjectsTableEvent>>[] = [];
  const transports: string[] = [];
  const session = bunja(() => {
    const machine = bunja.use(machineBunja);
    const daemonInstanceIdAtom = atom<string | undefined>("daemon");
    let closed = false;
    bunja.effect(() => () => {
      closed = true;
      state.set(daemonInstanceIdAtom, undefined);
    });
    return {
      daemonInstanceIdAtom,
      webTransport: () => {
        assert(!closed, "cleanup must not call disposed RPC dependency");
        transports.push(machine.machineId!);
        return Promise.resolve({} as WebTransport);
      },
    };
  });
  const agents = createAgentsBunja(session, {
    listAgentSessions: () => {
      const request = deferred<ListAgentSessionsRes>();
      requests.push(request);
      return request.promise;
    },
    createAgentProject: () => {
      const request = deferred<AgentProjectInfo>();
      creations.push(request);
      return request.promise;
    },
    createAgentSession: () => {
      const request = deferred<AgentSessionInfo>();
      sessionCreations.push(request);
      return request.promise;
    },
    updateAgentSession: () => {
      const request = deferred<AgentSessionInfo>();
      archives.push(request);
      return request.promise;
    },
    subscribeAgentProviders: () => {
      const result = stream<AgentProvidersTableEvent>();
      providers.push(result);
      return result.iterator;
    },
    subscribeAgentProjects: () => {
      const result = stream<AgentProjectsTableEvent>();
      projects.push(result);
      return result.iterator;
    },
  });
  return {
    state,
    store,
    read,
    agents,
    requests,
    creations,
    sessionCreations,
    archives,
    providers,
    projects,
    transports,
    session,
  };
}
test("agent effect is shared, survives partial cleanup, and rejects responses after final cleanup", async () => {
  const f = fixture();
  const a = f.store.get(f.agents, f.read());
  const stopA = a.mount();
  const b = f.store.get(f.agents, f.read());
  const stopB = b.mount();
  await flush();
  assert(
    a.value === b.value && f.requests.length === 1 && f.providers.length === 1,
  );
  stopA();
  assert(f.providers[0].returns() === 0);
  f.projects[0].send({ type: "snapshot", rows: [project] });
  await flush();
  assert(f.state.get(b.value.projectsAtom).length === 1);
  const pending = b.value.addProject("/old");
  await flush();
  const pendingSession = b.value.addSession("provider", {
    type: "project",
    projectId: "old",
  });
  await flush();
  const pendingArchive = b.value.archiveSession("old");
  await flush();
  stopB();
  assert(f.providers[0].returns() === 1 && f.projects[0].returns() === 1);
  const before = f.state.get(b.value.sessionsAtom);
  const beforeProjects = f.state.get(b.value.projectsAtom);
  const phase = f.state.get(b.value.phaseAtom);
  f.requests[0].reject(new Error("late failure"));
  f.creations[0].resolve({ ...project, projectId: "late" });
  // Only the summary id is observed by these operations.
  const result = { summary: { sessionId: "late" } } as AgentSessionInfo;
  f.sessionCreations[0].resolve(result);
  f.archives[0].resolve(result);
  await Promise.all([pending, pendingSession, pendingArchive]);
  await flush();
  assert(
    f.state.get(b.value.projectsAtom) === beforeProjects,
    "late project must not be inserted",
  );
  assert(
    f.state.get(b.value.sessionsAtom) === before,
    "late session operations must not write",
  );
  assert(
    f.state.get(b.value.phaseAtom) === phase &&
      f.state.get(b.value.errorAtom) === undefined,
    "late failure must not write",
  );
  const fresh = f.store.get(f.agents, f.read());
  const stopFresh = fresh.mount();
  await flush();
  assert(fresh.value !== b.value && f.requests.length === 2);
  f.requests[1].resolve({ rows: [], catalogRevision: 1 });
  await flush();
  stopFresh();
  f.store.dispose();
});
test("machine scopes stay isolated while selection switches and old requests complete", async () => {
  const f = fixture();
  const a = f.store.get(f.agents, f.read("a"));
  const stopA = a.mount();
  await flush();
  const machines = f.store.get(machineStoreBunja, f.read()).value;
  machines.selectMachine("b");
  await flush();
  assert(
    f.requests.length === 1,
    "global selection must not restart the scoped old machine",
  );
  const b = f.store.get(f.agents, f.read("b"));
  const stopB = b.mount();
  await flush();
  assert(a.value !== b.value && f.transports.join("") === "aaabbb");
  const oldProject = a.value.addProject("/old");
  await flush();
  // Changing the scoped machine credentials replaces its subscription lifetime.
  machines.updateMachine(
    "a",
    (machine) => ({ ...machine, clientSecret: "replacement" }),
  );
  await flush();
  assert(f.providers[0].returns() === 1 && f.requests.length === 3);
  f.requests[0].resolve({ rows: [], catalogRevision: 0 });
  f.creations[0].resolve(project);
  await oldProject;
  await flush();
  assert(
    f.state.get(a.value.phaseAtom) === "loading",
    "superseded list must not mark the new lifetime ready",
  );
  assert(f.state.get(a.value.projectsAtom).length === 0);
  stopA();
  f.requests[1].resolve({ rows: [], catalogRevision: 1 });
  f.requests[2].reject(new Error("old a"));
  await flush();
  assert(
    f.state.get(b.value.phaseAtom) === "ready" &&
      f.state.get(b.value.errorAtom) === undefined,
  );
  stopB();
  f.store.dispose();
});

test("old list success cannot write after final cleanup or overtake a newer refresh", async () => {
  const f = fixture();
  // Another feature retains RPC, so dependency teardown cannot invalidate the list for us.
  const stopSession = f.store.get(f.session, f.read()).mount();
  const entry = f.store.get(f.agents, f.read());
  const stop = entry.mount();
  await flush();
  const newer = entry.value.refreshSessions();
  await flush();
  f.requests[0].resolve({ rows: [], catalogRevision: 0 });
  await flush();
  assert(
    f.state.get(entry.value.phaseAtom) === "loading",
    "superseded initial refresh must not mark ready",
  );
  stop();
  const sessions = f.state.get(entry.value.sessionsAtom);
  const phase = f.state.get(entry.value.phaseAtom);
  f.requests[1].resolve({ rows: [], catalogRevision: 1 });
  await newer;
  await flush();
  assert(
    f.state.get(entry.value.sessionsAtom) === sessions &&
      f.state.get(entry.value.phaseAtom) === phase,
  );
  stopSession();
  f.store.dispose();
});
