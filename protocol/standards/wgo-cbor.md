# wgo CBOR Profile

This profile defines the CBOR encoding used by wgo wire envelope messages, wgo
RPC payloads, and method-level error payloads. It is intentionally narrower than
general CBOR so independent implementations can use existing CBOR libraries
while still agreeing on the wgo schema mapping and integer ranges.

Normative terms such as MUST, MUST NOT, SHOULD, and MAY are used as defined in
RFC 2119.

## Scope

- A wgo reqres stream is the byte-level envelope carried inside one WebTransport
  bidirectional stream.
- The body of that reqres stream is an RFC 8742 CBOR sequence of flattened
  `ReqResMessage` pairs: `kind` unsigned integer, then `fields` map, repeated
  until stream end.
- Each item in that sequence MUST be one complete CBOR value.
- A wgo datagram carries exactly one `DatagramMessage` encoded as a normal
  two-element union tuple: `[variant_id, fields_map]`.
- RPC payload and error fields are CBOR byte strings whose contents are decoded
  using the schema selected by proc id and response variant.
- All envelope values, RPC payload values, and method error payload values MUST
  follow this profile.

## Supported CBOR Data Model

wgo supports only these CBOR major types:

- Major type 0: unsigned integer.
- Major type 1: negative integer.
- Major type 2: byte string.
- Major type 3: UTF-8 text string.
- Major type 4: array.
- Major type 5: map.
- Major type 7: `false`, `true`, `null`, and 64-bit float.

The following CBOR features MUST NOT appear on the wire:

- Indefinite-length byte strings, text strings, arrays, or maps.
- Tags.
- Simple values other than `false`, `true`, and `null`.
- Half-precision or single-precision floats.
- Break bytes outside an indefinite-length item. Indefinite-length items are
  already forbidden.

## Deterministic Encoding

Encoders MUST produce deterministic CBOR:

- Integers MUST use the shortest valid CBOR additional-information form.
- Byte strings, text strings, arrays, and maps MUST use definite lengths.
- Map keys MUST be unsigned integer field ids.
- Map entries MUST be encoded in ascending numeric key order.
- Struct fields whose value is absent MUST be omitted rather than encoded as
  `null`, unless the schema explicitly declares `null` as part of the value.
- Union values MUST be encoded as a two-element array:
  `[variant_id, fields_map]`.
- `variant_id` MUST be an unsigned integer.
- A union `fields_map` MUST follow the same map rules as struct fields.
- The top-level `ReqResMessage` reqres-stream encoding is the only exception: it
  omits the two-element array wrapper and sends `variant_id` and `fields_map` as
  two consecutive CBOR sequence items.
- `void` has no payload. A successful `void` response MUST omit the payload
  field rather than encode a CBOR `null`.

Decoders MAY reject non-deterministic but otherwise valid CBOR, such as
non-shortest integer encodings or maps encoded out of key order. This is useful
for strict conformance tests, but it is not required for basic interoperability.

## Decoder Requirements

Decoders MUST reject:

- Duplicate map keys.
- Map keys that are not unsigned integers.
- Unknown enum item ids.
- Unknown union variant ids.
- CBOR data that has trailing bytes when a single value is expected.
- Invalid UTF-8 in text strings.
- Values outside the range of the schema primitive being decoded.
- Values whose CBOR type does not match the schema primitive.

Decoders SHOULD ignore unknown struct fields by default so newer peers can add
optional fields without breaking older peers. A method may define stricter
handling for a specific request type when accepting unknown fields would change
security or filesystem behavior.

Encoders MUST include required struct fields. Schema-aware decoders SHOULD
treat absent required fields as the field type's default value when doing so is
safe for that method: `false` for `bool`, `0` for integers and floats, `""` for
`string`, empty bytes for `bytes`, and empty collections for arrays and maps.
Present fields with the wrong CBOR type MUST still be rejected. Domain types
such as enums and unions should use the schema's empty, failed, or unknown
variant when one exists; otherwise the decoder may reject the missing field.

## Primitive Mapping

- `bool` maps to CBOR `false` or `true`.
- `i53` maps to a CBOR integer and MUST fit in JavaScript's safe integer range,
  `-(2^53 - 1)` through `2^53 - 1`.
- `u53` maps to a CBOR unsigned integer and MUST fit in `0` through `2^53 - 1`.
- `f64` maps to CBOR major type 7 additional information 27.
- `string` maps to a CBOR UTF-8 text string.
- `bytes` maps to a CBOR byte string.
- `void` maps to no CBOR value.

wgo wire and RPC schemas SHOULD use `i53` and `u53` for integer fields unless a
future method explicitly requires exact integer values outside the safe-integer
range. JavaScript implementations MAY represent all wgo wire/RPC schema integers
as `number`.

## Size Limits

Implementations MUST enforce local size limits before allocating large buffers.
The protocol intentionally does not set one global maximum because practical
limits depend on the transport endpoint, method, and deployment target.

If a message or payload exceeds an implementation limit, the callee SHOULD fail
the invocation with a stable protocol or method error rather than truncating.
Future method schemas may define method-specific size-limit errors.
