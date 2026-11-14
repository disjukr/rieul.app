// Frozen generated terminal codecs from ebf6c14, before optional attach control.
// Extracted with TypeScript transpilation; private helpers remain unchanged.
export function encodeTerminalLaunchSpecValue(value) {
    const fields = new Map();
    fields.set(1, text(required(value.command, "TerminalLaunchSpec.command")));
    fields.set(2, required(value.args, "TerminalLaunchSpec.args").map((item) => text(item)));
    return fields;
}

export function decodeTerminalLaunchSpecValue(value) {
    const fields = expectMap(value);
    return {
        command: fieldOrDefault(fields.get(1), (value) => textValue(value), () => ""),
        args: fieldOrDefault(fields.get(2), (value) => array(value).map((item) => textValue(item)), () => []),
    };
}

export function encodeTerminalSessionInfoValue(value) {
    const fields = new Map();
    fields.set(1, text(required(value.terminalSessionId, "TerminalSessionInfo.terminalSessionId")));
    fields.set(2, text(required(value.creatorClientId, "TerminalSessionInfo.creatorClientId")));
    fields.set(3, u53(required(value.createdAtMs, "TerminalSessionInfo.createdAtMs")));
    if (value.lastAttachedAtMs !== undefined)
        fields.set(4, u53(value.lastAttachedAtMs));
    if (value.lastDetachedAtMs !== undefined)
        fields.set(5, u53(value.lastDetachedAtMs));
    if (value.lastOutputAtMs !== undefined)
        fields.set(6, u53(value.lastOutputAtMs));
    fields.set(7, u53(required(value.cols, "TerminalSessionInfo.cols")));
    fields.set(8, u53(required(value.rows, "TerminalSessionInfo.rows")));
    if (value.primaryAttachId !== undefined)
        fields.set(9, text(value.primaryAttachId));
    fields.set(10, u53(required(value.latestOutputSeq, "TerminalSessionInfo.latestOutputSeq")));
    if (value.lastKnownTitle !== undefined)
        fields.set(11, text(value.lastKnownTitle));
    if (value.exit !== undefined)
        fields.set(12, encodeTerminalExitValue(value.exit));
    if (value.lastKnownCwd !== undefined)
        fields.set(13, text(value.lastKnownCwd));
    fields.set(14, encodeTerminalLaunchSpecValue(required(value.launch, "TerminalSessionInfo.launch")));
    return fields;
}

export function decodeTerminalSessionInfoValue(value) {
    const fields = expectMap(value);
    return {
        terminalSessionId: fieldOrDefault(fields.get(1), (value) => textValue(value), () => ""),
        creatorClientId: fieldOrDefault(fields.get(2), (value) => textValue(value), () => ""),
        createdAtMs: fieldOrDefault(fields.get(3), (value) => integer(value), () => 0),
        lastAttachedAtMs: optionalField(fields.get(4), (value) => integer(value)),
        lastDetachedAtMs: optionalField(fields.get(5), (value) => integer(value)),
        lastOutputAtMs: optionalField(fields.get(6), (value) => integer(value)),
        cols: fieldOrDefault(fields.get(7), (value) => integer(value), () => 0),
        rows: fieldOrDefault(fields.get(8), (value) => integer(value), () => 0),
        primaryAttachId: optionalField(fields.get(9), (value) => textValue(value)),
        latestOutputSeq: fieldOrDefault(fields.get(10), (value) => integer(value), () => 0),
        lastKnownTitle: optionalField(fields.get(11), (value) => textValue(value)),
        exit: optionalField(fields.get(12), (value) => decodeTerminalExitValue(value)),
        lastKnownCwd: optionalField(fields.get(13), (value) => textValue(value)),
        launch: fieldOrDefault(fields.get(14), (value) => decodeTerminalLaunchSpecValue(value), () => defaultTerminalLaunchSpec()),
    };
}

export function encodeAttachTerminalSessionReqValue(value) {
    const fields = new Map();
    fields.set(1, text(required(value.terminalSessionId, "AttachTerminalSessionReq.terminalSessionId")));
    if (value.afterSeq !== undefined)
        fields.set(2, u53(value.afterSeq));
    fields.set(3, u53(required(value.viewportCols, "AttachTerminalSessionReq.viewportCols")));
    fields.set(4, u53(required(value.viewportRows, "AttachTerminalSessionReq.viewportRows")));
    if (value.screenSnapshots !== undefined)
        fields.set(5, bool(value.screenSnapshots));
    return fields;
}

export function decodeAttachTerminalSessionReqValue(value) {
    const fields = expectMap(value);
    return {
        terminalSessionId: fieldOrDefault(fields.get(1), (value) => textValue(value), () => ""),
        afterSeq: optionalField(fields.get(2), (value) => integer(value)),
        viewportCols: fieldOrDefault(fields.get(3), (value) => integer(value), () => 0),
        viewportRows: fieldOrDefault(fields.get(4), (value) => integer(value), () => 0),
        screenSnapshots: optionalField(fields.get(5), (value) => boolValue(value)),
    };
}

export function encodeTerminalEventValue(value) {
    switch (value.type) {
        case "attached": {
            const fields = new Map();
            fields.set(1, text(required(value.attachId, "TerminalEvent.Attached.attachId")));
            if (value.primaryAttachId !== undefined)
                fields.set(2, text(value.primaryAttachId));
            fields.set(3, encodeTerminalSessionInfoValue(required(value.session, "TerminalEvent.Attached.session")));
            return [1, fields];
        }
        case "outputChunk": {
            const fields = new Map();
            fields.set(1, u53(required(value.seq, "TerminalEvent.OutputChunk.seq")));
            fields.set(2, bytes(required(value.bytes, "TerminalEvent.OutputChunk.bytes")));
            return [2, fields];
        }
        case "historyGap": {
            const fields = new Map();
            fields.set(1, u53(required(value.nextSeq, "TerminalEvent.HistoryGap.nextSeq")));
            if (value.reconnect !== undefined)
                fields.set(2, bool(value.reconnect));
            return [3, fields];
        }
        case "controlChanged": {
            const fields = new Map();
            fields.set(1, text(required(value.primaryAttachId, "TerminalEvent.ControlChanged.primaryAttachId")));
            return [4, fields];
        }
        case "pseudoTerminalResized": {
            const fields = new Map();
            fields.set(1, u53(required(value.cols, "TerminalEvent.PseudoTerminalResized.cols")));
            fields.set(2, u53(required(value.rows, "TerminalEvent.PseudoTerminalResized.rows")));
            return [5, fields];
        }
        case "sessionExited": {
            const fields = new Map();
            fields.set(1, encodeTerminalExitValue(required(value.exit, "TerminalEvent.SessionExited.exit")));
            return [6, fields];
        }
        case "sessionClosed": {
            const fields = new Map();
            fields.set(1, encodeTerminalSessionCloseReasonValue(required(value.reason, "TerminalEvent.SessionClosed.reason")));
            return [7, fields];
        }
        case "workingDirectoryChanged": {
            const fields = new Map();
            fields.set(1, text(required(value.cwd, "TerminalEvent.WorkingDirectoryChanged.cwd")));
            return [8, fields];
        }
        case "titleChanged": {
            const fields = new Map();
            fields.set(1, text(required(value.title, "TerminalEvent.TitleChanged.title")));
            return [9, fields];
        }
        case "screenSnapshot": {
            const fields = new Map();
            fields.set(1, u53(required(value.baseSeq, "TerminalEvent.ScreenSnapshot.baseSeq")));
            fields.set(2, u53(required(value.cols, "TerminalEvent.ScreenSnapshot.cols")));
            fields.set(3, u53(required(value.rows, "TerminalEvent.ScreenSnapshot.rows")));
            fields.set(4, bytes(required(value.bytes, "TerminalEvent.ScreenSnapshot.bytes")));
            return [10, fields];
        }
    }
}

export function decodeTerminalEventValue(value) {
    const [variantId, fields] = expectUnion(value);
    switch (variantId) {
        case 1:
            return {
                type: "attached",
                attachId: fieldOrDefault(fields.get(1), (value) => textValue(value), () => ""),
                primaryAttachId: optionalField(fields.get(2), (value) => textValue(value)),
                session: fieldOrDefault(fields.get(3), (value) => decodeTerminalSessionInfoValue(value), () => defaultTerminalSessionInfo()),
            };
        case 2:
            return {
                type: "outputChunk",
                seq: fieldOrDefault(fields.get(1), (value) => integer(value), () => 0),
                bytes: fieldOrDefault(fields.get(2), (value) => bytesValue(value), () => new Uint8Array()),
            };
        case 3:
            return {
                type: "historyGap",
                nextSeq: fieldOrDefault(fields.get(1), (value) => integer(value), () => 0),
                reconnect: optionalField(fields.get(2), (value) => boolValue(value)),
            };
        case 4:
            return {
                type: "controlChanged",
                primaryAttachId: fieldOrDefault(fields.get(1), (value) => textValue(value), () => ""),
            };
        case 5:
            return {
                type: "pseudoTerminalResized",
                cols: fieldOrDefault(fields.get(1), (value) => integer(value), () => 0),
                rows: fieldOrDefault(fields.get(2), (value) => integer(value), () => 0),
            };
        case 6:
            return {
                type: "sessionExited",
                exit: fieldOrDefault(fields.get(1), (value) => decodeTerminalExitValue(value), () => defaultTerminalExit()),
            };
        case 7:
            return {
                type: "sessionClosed",
                reason: fieldOrDefault(fields.get(1), (value) => decodeTerminalSessionCloseReasonValue(value), () => defaultTerminalSessionCloseReason()),
            };
        case 8:
            return {
                type: "workingDirectoryChanged",
                cwd: fieldOrDefault(fields.get(1), (value) => textValue(value), () => ""),
            };
        case 9:
            return {
                type: "titleChanged",
                title: fieldOrDefault(fields.get(1), (value) => textValue(value), () => ""),
            };
        case 10:
            return {
                type: "screenSnapshot",
                baseSeq: fieldOrDefault(fields.get(1), (value) => integer(value), () => 0),
                cols: fieldOrDefault(fields.get(2), (value) => integer(value), () => 0),
                rows: fieldOrDefault(fields.get(3), (value) => integer(value), () => 0),
                bytes: fieldOrDefault(fields.get(4), (value) => bytesValue(value), () => new Uint8Array()),
            };
    }
    throw new Error(`unknown TerminalEvent variant ${variantId}`);
}

export function encodeTerminalExitValue(value) {
    const fields = new Map();
    if (value.code !== undefined)
        fields.set(1, i53(value.code));
    if (value.signal !== undefined)
        fields.set(2, text(value.signal));
    fields.set(3, u53(required(value.exitedAtMs, "TerminalExit.exitedAtMs")));
    return fields;
}

export function decodeTerminalExitValue(value) {
    const fields = expectMap(value);
    return {
        code: optionalField(fields.get(1), (value) => integer(value)),
        signal: optionalField(fields.get(2), (value) => textValue(value)),
        exitedAtMs: fieldOrDefault(fields.get(3), (value) => integer(value), () => 0),
    };
}

export function encodeTerminalSessionCloseReasonValue(value) {
    switch (value.type) {
        case "failed": {
            const fields = new Map();
            fields.set(1, text(required(value.message, "TerminalSessionCloseReason.Failed.message")));
            return [0, fields];
        }
        case "closedByClient": {
            const fields = new Map();
            return [1, fields];
        }
        case "daemonShuttingDown": {
            const fields = new Map();
            return [2, fields];
        }
        case "unknown": {
            const fields = new Map();
            return [3, fields];
        }
    }
}

export function decodeTerminalSessionCloseReasonValue(value) {
    const [variantId, fields] = expectUnion(value);
    switch (variantId) {
        case 0:
            return {
                type: "failed",
                message: fieldOrDefault(fields.get(1), (value) => textValue(value), () => ""),
            };
        case 1:
            return {
                type: "closedByClient",
            };
        case 2:
            return {
                type: "daemonShuttingDown",
            };
        case 3:
            return {
                type: "unknown",
            };
    }
    throw new Error(`unknown TerminalSessionCloseReason variant ${variantId}`);
}

function defaultTerminalLaunchSpec() {
    return {
        command: "",
        args: [],
    };
}

function defaultTerminalSessionInfo() {
    return {
        terminalSessionId: "",
        creatorClientId: "",
        createdAtMs: 0,
        cols: 0,
        rows: 0,
        latestOutputSeq: 0,
        launch: defaultTerminalLaunchSpec(),
    };
}

function defaultTerminalExit() {
    return {
        exitedAtMs: 0,
    };
}

function defaultTerminalSessionCloseReason() {
    return {
        type: "failed",
        message: "",
    };
}

function expectMap(value) {
    if (!(value instanceof Map))
        throw new Error("expected CBOR map");
    return value;
}

function expectUnion(value) {
    if (!Array.isArray(value) || value.length !== 2)
        throw new Error("expected CBOR union tuple");
    return [integer(value[0]), expectMap(value[1])];
}

function array(value) {
    if (!Array.isArray(value))
        throw new Error("expected CBOR array");
    return value;
}

function integer(value) {
    if (typeof value !== "number" || !Number.isSafeInteger(value))
        throw new Error("expected CBOR integer");
    return value;
}

function textValue(value) {
    if (typeof value !== "string")
        throw new Error("expected CBOR text");
    return value;
}

function boolValue(value) {
    if (typeof value !== "boolean")
        throw new Error("expected CBOR bool");
    return value;
}

function bytesValue(value) {
    if (!(value instanceof Uint8Array))
        throw new Error("expected CBOR bytes");
    return value;
}

function optionalField(value, decode) {
    return value === undefined ? undefined : decode(value);
}

function fieldOrDefault(value, decode, fallback) {
    return value === undefined ? fallback() : decode(value);
}

function required(value, label) {
    if (value === undefined)
        throw new Error(`missing required field ${label}`);
    return value;
}

function u53(value) {
    if (!Number.isSafeInteger(value) || value < 0)
        throw new Error("expected u53");
    return value;
}

function i53(value) {
    if (!Number.isSafeInteger(value))
        throw new Error("expected i53");
    return value;
}

function text(value) {
    if (typeof value !== "string")
        throw new Error("expected string");
    return value;
}

function bool(value) {
    if (typeof value !== "boolean")
        throw new Error("expected boolean");
    return value;
}

function bytes(value) {
    if (!(value instanceof Uint8Array))
        throw new Error("expected Uint8Array");
    return value;
}
