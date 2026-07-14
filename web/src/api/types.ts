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

export type IndexerResponse = S["IndexerResponse"];
export type IndexerWrite = S["IndexerWrite"];
export type IndexerTestResult = S["IndexerTestResult"];
export type ReorderRequest = S["ReorderRequest"];

export type ProviderResponse = S["ProviderResponse"];
export type ProviderWrite = S["ProviderWrite"];
export type ProviderTestResult = S["ProviderTestResult"];

export type QualityProfile = S["QualityProfile"];
export type SizeBand = S["SizeBand"];

export type DebugSearchRequest = S["DebugSearchRequest"];
export type DebugSearchResponse = S["DebugSearchResponse"];
export type DebugWorkDto = S["DebugWorkDto"];
export type DebugReleaseDto = S["DebugReleaseDto"];
export type ParsedFieldsDto = S["ParsedFieldsDto"];
export type ScoreLineDto = S["ScoreLineDto"];
export type RejectionDto = S["RejectionDto"];
export type IndexerDiagnosticDto = S["IndexerDiagnosticDto"];

export type ResolveRequest = S["ResolveRequest"];
export type ResolveResponse = S["ResolveResponse"];
export type MediaStreamInfo = S["MediaStreamInfo"];

export type SessionResponse = S["SessionResponse"];
export type ReachabilityStatus = S["ReachabilityStatus"];
