# rieul Socket Wire

This document defines the socket-oriented wire layer for transports that expose
one ordered bidirectional byte or message channel. Examples include WebSocket
fallback, named pipes, and Unix domain sockets.

Socket wire is only a wire/envelope layer. Business-level method contracts use
the existing `rieul-rpc` standard.

The socket-wire schema uses the `rieul-wire` BDL standard because it shares the
same deterministic rieul CBOR profile, primitive set, and field/variant id
rules. It differs from the current WebTransport `rieul-wire` reqres shape by
multiplexing logical RPC streams over one bidirectional channel.

Normative terms such as MUST, MUST NOT, SHOULD, and MAY are used as defined in
RFC 2119.

## Goals

- Reuse `rieul-wire` schema encoding rules.
- Reuse `rieul-rpc` proc contracts, stream shapes, payload schemas, and
  method-level errors.
- Provide stream ids and explicit end messages for transports that expose one
  ordered bidirectional channel instead of independent bidirectional streams.
- Support WebSocket fallback and local socket-like transports with one binary
  message protocol.

## Layering

`rieul-rpc` defines business semantics:

- proc ids,
- `unary`, `client`, `server`, and `bidi` stream shapes,
- request and response payload schemas,
- method-level error unions.

`rieul-wire` defines the shared schema encoding rules and the WebTransport
envelope family.

`rieul-socket-wire` defines a reqres envelope family for single-channel
transports:

- socket session-control messages,
- logical stream ids,
- request/response data and direction-end messages.

The WebTransport reqres layer can keep its optimized shape: one WebTransport
bidirectional stream carries one RPC exchange. Socket-style transports need
this extra multiplexing layer because they expose one ordered channel rather
than independent bidirectional streams.

## Transport Binding

Socket wire is a sequence of flattened binary reqres message pairs. The
transport binding defines how the sequence is carried:

- Byte-stream transports carry one continuous CBOR sequence:
  `variant_id, fields_map, variant_id, fields_map, ...`.
- Message transports such as WebSocket MUST carry exactly one flattened socket
  reqres pair per binary message.

Text WebSocket messages are reserved and MUST be rejected.

Implementations MUST enforce local maximum message and stream-buffer sizes before
allocating large buffers.

## Message Encoding

Each socket reqres message uses the same flattened top-level encoding as
WebTransport `ReqResMessage`: an RFC 8742-style CBOR sequence containing
exactly two complete deterministic CBOR items:

```text
variant_id, fields_map
```

`variant_id` is the `SocketReqResMessage` union variant id encoded as a CBOR
unsigned integer. `fields_map` is that variant's CBOR map. The normal
two-element union array wrapper is omitted only for this top-level socket reqres
message grammar. Nested unions and payload values still use the normal
two-element array union encoding.

On byte-stream transports, each `variant_id, fields_map` pair is delimited by
the CBOR item boundaries themselves. There is no extra length prefix. On
message transports, the transport message boundary MUST delimit exactly one
flattened socket reqres pair. WebSocket encoders MUST NOT concatenate multiple
pairs inside one binary message.

## Relation to WebTransport Reqres

`SocketReqResMessage` mirrors WebTransport `ReqResMessage` one-to-one for
variants 0 through 10:

- `RequestUnary`
- `RequestStreamStart`
- `RequestStreamChunk`
- `ResponseUnaryOk`
- `ResponseUnaryError`
- `ResponseStreamStart`
- `ResponseStreamChunk`
- `ResponseStreamErrorEnd`
- `SessionAuthenticate`
- `SessionAuthenticated`
- `SessionAuthError`

Socket reqres adds:

- `streamId` on every logical-stream message, so many reqres exchanges can
  share one socket.
- `RequestStreamEnd` and `ResponseStreamEnd`, because socket transports do not
  provide per-logical-stream half-close/EOF.

Socket-wire-only field and variant ids start at 100. This keeps variants 0
through 99 available for future one-to-one additions from WebTransport
`ReqResMessage`.

## Session Control

Session control uses the same stream model as RPC invocations. A client
authenticates the socket session by opening a logical stream with
`SessionAuthenticate`, then sending `RequestStreamEnd`. The server replies with
`SessionAuthenticated` or `SessionAuthError`, then sends `ResponseStreamEnd`.

## Logical Streams

Socket wire multiplexes reliable logical streams over one connection. Each RPC
exchange uses one logical stream.

`streamId` is a non-zero unsigned safe integer. The connection initiator uses
odd stream ids. The receiver uses even stream ids. Stream ids MUST NOT be reused
within one connection.

Message families:

- request-start messages start one logical RPC stream,
- request/response chunk messages carry payload bytes,
- request/response end messages end one direction normally,
- malformed socket-wire messages are transport/session failures and normally
  close the connection.

The transport binding selects the proc registry for the connection. For
example, WebSocket fallback normally selects the public `rieul.rpc` registry,
while local GUI IPC selects the `rieul.ipc` registry. The selected registry and
proc id determine which `rieul-rpc` payload schemas apply to request and
response payload bytes.

## Stream Semantics

For unary calls, the caller sends:

```text
RequestUnary(streamId, procId, request payload bytes)
RequestStreamEnd(streamId)
```

The callee replies on the same `streamId`:

```text
ResponseUnaryOk(streamId, response payload bytes)
ResponseStreamEnd(streamId)
```

For client, server, and bidi streaming calls, each side sends any number of
request/response chunk messages before its own direction-end message. Direction
end closes only the sender's direction.

Void payloads are represented by omitting the optional payload field and sending
the relevant direction-end message.

Method-level errors are encoded according to the selected `rieul-rpc` method
contract. Transport, routing, framing, authorization, and malformed payload
failures use the same `ResponseUnaryError` and `ResponseStreamErrorEnd` shapes
as WebTransport reqres when they belong to one logical RPC exchange. Malformed
socket-wire messages that cannot be assigned to a valid logical stream are
transport/session failures.

Error messages are diagnostic text and MUST NOT be parsed for control flow.

## Security

Socket wire does not define authentication by itself. The selected proc
registry and transport binding define authentication and authorization
requirements.

WebSocket fallback for protected public RPC procs MUST use the existing session
authentication model before protected methods are available.

Receivers MUST validate message CBOR, protocol version, selected proc registry,
proc id, stream shape, payload schema, numeric fields, and size limits before
acting on requests.
