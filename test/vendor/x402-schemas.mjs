// VENDORED - do not edit by hand.
//
// Verbatim copy of the x402 payment-requirements zod schemas from the build a
// real client validates against:
//
//   package : @x402/core 2.20.0
//   file    : dist/esm/chunk-N4QXZG2Z.mjs, the schema declarations from
//             `var NonEmptyString` up to `var PaymentRequirementsSchema`
//   sha256  : 19c189f7417214b211ee4abdaada531a80e5adc8504d593c172fe1e2ce61c03e
//   read    : 2026-09-07 from the study rig at
//             delivery-incidence-study/rig/node_modules - the same installed
//             build the T0 compatibility test ran against (RAIL_T0 E1)
//   zod     : 3.25.76, the version that build resolves (devDependency here)
//
// It is vendored rather than imported because the worker does not depend on
// @x402/core: the worker is the SERVER, and a server that imported the client
// library to check its own output would be marking its own homework with the
// same code that produced it. Transcribing by hand was rejected for the same
// reason - a hand-written validator can be wrong in the same direction as the
// builder it checks. This is a byte copy of the real schemas.
//
// Cross-checked against the published spec, fetched 2026-09-07:
//   specs/x402-specification-v2.md  sha256 aa6dc5e8ccc7758689945fc7502674f51cd0f21f09ec886aa1dbc4cd86bc81b6
//   specs/x402-specification-v1.md  sha256 4484cd856f3add013ba64485b5234364429fe46dc8f846e9bcc72f50eb80b7b6
//
// To refresh: re-copy the same declarations from a newer installed build and
// re-record the digest above in the same commit.

import { z } from 'zod';

var NonEmptyString = z.string().min(1);
var Any = z.record(z.unknown());
var OptionalAny = z.record(z.unknown()).optional().nullable();
var NetworkSchemaV1 = NonEmptyString;
var NetworkSchemaV2 = z.string().min(3).refine((val) => val.includes(":"), {
  message: "Network must be in CAIP-2 format (e.g., 'eip155:84532')"
});
var NetworkSchema = z.union([NetworkSchemaV1, NetworkSchemaV2]);
var PRINTABLE_ASCII_REGEX = /^[\x20-\x7e]+$/;
var ResourceInfoSchema = z.object({
  url: NonEmptyString,
  description: z.string().nullish().transform((v) => v ?? void 0),
  mimeType: z.string().nullish().transform((v) => v ?? void 0),
  serviceName: z.string().min(1).max(32).regex(PRINTABLE_ASCII_REGEX).nullish().transform((v) => v ?? void 0),
  tags: z.array(z.string().min(1).max(32).regex(PRINTABLE_ASCII_REGEX)).max(5).nullish().transform((v) => v ?? void 0),
  iconUrl: z.string().max(2048).nullish().transform((v) => v ?? void 0)
});
var PaymentRequirementsV1Schema = z.object({
  scheme: NonEmptyString,
  network: NetworkSchemaV1,
  maxAmountRequired: NonEmptyString,
  resource: NonEmptyString,
  // URL string in V1
  description: z.string(),
  mimeType: z.string().optional(),
  outputSchema: Any.optional().nullable(),
  payTo: NonEmptyString,
  maxTimeoutSeconds: z.number().positive(),
  asset: NonEmptyString,
  extra: OptionalAny
});
var PaymentRequiredV1Schema = z.object({
  x402Version: z.literal(1),
  error: z.string().optional(),
  accepts: z.array(PaymentRequirementsV1Schema).min(1)
});
var PaymentPayloadV1Schema = z.object({
  x402Version: z.literal(1),
  scheme: NonEmptyString,
  network: NetworkSchemaV1,
  payload: Any
});
var PaymentRequirementsV2Schema = z.object({
  scheme: NonEmptyString,
  network: NetworkSchemaV2,
  amount: NonEmptyString,
  asset: NonEmptyString,
  payTo: NonEmptyString,
  maxTimeoutSeconds: z.number().positive(),
  extra: OptionalAny
});
var PaymentRequiredV2Schema = z.object({
  x402Version: z.literal(2),
  error: z.string().nullish().transform((v) => v ?? void 0),
  resource: ResourceInfoSchema,
  accepts: z.array(PaymentRequirementsV2Schema).min(1),
  extensions: OptionalAny
});
var PaymentPayloadV2Schema = z.object({
  x402Version: z.literal(2),
  resource: ResourceInfoSchema.nullish().transform((v) => v ?? void 0),
  accepted: PaymentRequirementsV2Schema,
  payload: Any,
  extensions: OptionalAny
});

export {
	NonEmptyString,
	NetworkSchemaV1,
	NetworkSchemaV2,
	ResourceInfoSchema,
	PaymentRequirementsV1Schema,
	PaymentRequiredV1Schema,
	PaymentPayloadV1Schema,
	PaymentRequirementsV2Schema,
	PaymentRequiredV2Schema,
	PaymentPayloadV2Schema,
};
