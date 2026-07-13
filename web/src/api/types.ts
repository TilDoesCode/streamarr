import type { components } from "./schema";

// Convenience aliases over the generated schema (BRIEF §9.2: no hand-written API types —
// everything here re-exports `components["schemas"][...]`).
type S = components["schemas"];

export type LoginRequest = S["LoginRequest"];
export type LoginResponse = S["LoginResponse"];
export type MeResponse = S["MeResponse"];
export type ChangePasswordRequest = S["ChangePasswordRequest"];

export type GeneralConfigResponse = S["GeneralConfigResponse"];
export type GeneralConfigWrite = S["GeneralConfigWrite"];

export type ApiKeyResponse = S["ApiKeyResponse"];
export type CreateApiKeyRequest = S["CreateApiKeyRequest"];
export type CreatedApiKeyResponse = S["CreatedApiKeyResponse"];

export type HealthResponse = S["HealthResponse"];
