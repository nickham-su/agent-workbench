import { Type } from "@sinclair/typebox";
import type { Static } from "@sinclair/typebox";

export const NetworkSettingsSchema = Type.Object({
  httpProxy: Type.Union([Type.String(), Type.Null()]),
  httpsProxy: Type.Union([Type.String(), Type.Null()]),
  noProxy: Type.Union([Type.String(), Type.Null()]),
  caCertPem: Type.Union([Type.String(), Type.Null()]),
  updatedAt: Type.Number()
});
export type NetworkSettings = Static<typeof NetworkSettingsSchema>;

export const UpdateNetworkSettingsRequestSchema = Type.Object({
  httpProxy: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  httpsProxy: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  noProxy: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  caCertPem: Type.Optional(Type.Union([Type.String(), Type.Null()]))
});
export type UpdateNetworkSettingsRequest = Static<typeof UpdateNetworkSettingsRequestSchema>;

export const MasterKeySourceSchema = Type.Union([Type.Literal("env"), Type.Literal("file"), Type.Literal("generated")]);
export type MasterKeySource = Static<typeof MasterKeySourceSchema>;

export const SecurityStatusSchema = Type.Object({
  credentialMasterKey: Type.Object({
    source: MasterKeySourceSchema,
    keyId: Type.String(),
    createdAt: Type.Union([Type.Number(), Type.Null()])
  }),
  sshKnownHostsPath: Type.String()
});
export type SecurityStatus = Static<typeof SecurityStatusSchema>;

export const ResetKnownHostRequestSchema = Type.Object({
  host: Type.String({ minLength: 1 })
});
export type ResetKnownHostRequest = Static<typeof ResetKnownHostRequestSchema>;

