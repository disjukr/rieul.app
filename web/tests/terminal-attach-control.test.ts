import assert from "node:assert/strict";
import { test } from "node:test";

import type {
  TerminalAttachControlResult,
  TerminalEvent,
} from "../src/protocol/generated/rpc.ts";
import {
  allowsNewTerminalInput,
  requestTerminalAttachControl,
  terminalAttachControl,
} from "../src/view/workbench/tool/terminal/attach-control.ts";

function attached(
  controlResult?: TerminalAttachControlResult,
): Extract<TerminalEvent, { type: "attached" }> {
  return {
    type: "attached",
    attachId: "self",
    primaryAttachId: controlResult?.type === "granted" ? controlResult.primaryAttachId : "other",
    controlResult,
    session: {
      terminalSessionId: "session",
      creatorClientId: "client",
      createdAtMs: 0,
      cols: 80,
      rows: 24,
      latestOutputSeq: 0,
      launch: { command: "/bin/sh", args: [] },
    },
  };
}

test("a matching grant is usable only for an active pending input start", () => {
  const event = attached({ type: "granted", primaryAttachId: "self" });
  const active = terminalAttachControl(event, true);
  assert.equal(active.primaryAttachId, "self");
  assert.equal(allowsNewTerminalInput(active, true), true);
  assert.equal(allowsNewTerminalInput(active, false), false);

  const blurredWhileAttaching = terminalAttachControl(event, false);
  assert.equal(blurredWhileAttaching.primaryAttachId, undefined);
  assert.equal(allowsNewTerminalInput(blurredWhileAttaching, false), false);
  const wrongOwner = terminalAttachControl(
    attached({ type: "granted", primaryAttachId: "other" }),
    true,
  );
  assert.equal(wrongOwner.primaryAttachId, undefined);
  assert.equal(allowsNewTerminalInput(wrongOwner, true), false);
});

test("refusal blocks focus, ResizeObserver, and input for the same attachment", () => {
  const rejected = terminalAttachControl(
    attached({
      type: "rejected",
      error: { type: "invalidSize", message: "Invalid terminal size" },
    }),
    true,
  );
  assert.equal(rejected.refusal, "Invalid terminal size");
  const request = async () => assert.fail("refused attachment retried control");
  const pending = {};
  for (const active of [false, true, false, true]) {
    assert.equal(allowsNewTerminalInput(rejected, active), false);
    for (const ownsControl of [false, true]) {
      assert.equal(
        requestTerminalAttachControl(
          rejected,
          active,
          ownsControl,
          pending,
          request,
        ),
        undefined,
      );
    }
  }
  assert.equal(
    allowsNewTerminalInput(terminalAttachControl(attached(), true), true),
    true,
  );
});

for (const result of [undefined, { type: "notAttempted" }] as const) {
  test(`${result?.type ?? "legacy"} attachment shares one active fallback`, async () => {
    const control = terminalAttachControl(attached(result), true);
    const pending: { current?: Promise<void> } = {};
    let calls = 0;
    let release = () => {};
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const request = async () => {
      calls += 1;
      await blocked;
    };
    assert.equal(
      requestTerminalAttachControl(control, false, false, pending, request),
      undefined,
    );
    const first = requestTerminalAttachControl(
      control,
      true,
      false,
      pending,
      request,
    );
    const second = requestTerminalAttachControl(
      control,
      true,
      false,
      pending,
      request,
    );
    const third = requestTerminalAttachControl(
      control,
      true,
      false,
      pending,
      request,
    );
    assert.equal(first, second);
    assert.equal(first, third);
    assert.equal(calls, 1);
    release();
    await first;
    assert.equal(pending.current, undefined);
    // Once controlling, a normal later resize still issues a control RPC.
    await requestTerminalAttachControl(control, true, true, pending, request);
    assert.equal(calls, 2);
  });
}


test("a grant inconsistent with authoritative Attached metadata is refused", () => {
  const event = attached({type:"granted",primaryAttachId:"self"});
  event.primaryAttachId="other";
  const control=terminalAttachControl(event,true);
  assert.equal(control.primaryAttachId,undefined);
  assert.equal(allowsNewTerminalInput(control,true),false);
});
