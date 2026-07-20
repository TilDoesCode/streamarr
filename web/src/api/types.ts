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
export type NotificationConfigResponse = S["NotificationConfigResponse"];
export type NotificationConfigWrite = S["NotificationConfigWrite"];
export type NotificationTestResponse = S["NotificationTestResponse"];

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
export type ProviderSpeedTestRequest = S["ProviderSpeedTestRequest"];
export type ProviderSpeedTestResult = S["ProviderSpeedTestResult"];

export type QualityProfile = S["QualityProfile"];
export type SizeBand = S["SizeBand"];
export type CustomFormatScore = S["CustomFormatScore"];
export type ProfileImportPreviewRequest = S["ProfileImportPreviewRequest"];
export type ProfileImportPreviewResponse = S["ProfileImportPreviewResponse"];
export type ProfileImportRequest = S["ProfileImportRequest"];
export type ProfileImportCandidate = S["ProfileImportCandidate"];

export type DebugSearchRequest = S["DebugSearchRequest"];
export type DebugSearchResponse = S["DebugSearchResponse"];
export type DebugWorkDto = S["DebugWorkDto"];
export type DebugReleaseDto = S["DebugReleaseDto"];
export type SearchResponse = S["SearchResponse"];
export type WorkDto = S["WorkDto"];
export type ReleaseDto = S["ReleaseDto"];
export type QualityDto = S["QualityDto"];
export type ParsedFieldsDto = S["ParsedFieldsDto"];
export type ScoreLineDto = S["ScoreLineDto"];
export type RejectionDto = S["RejectionDto"];
export type IndexerDiagnosticDto = S["IndexerDiagnosticDto"];
export type TvSeriesSearchResponse = S["TvSeriesSearchResponse"];
export type TvSeriesDetailsResponse = S["TvSeriesDetailsResponse"];
export type TvSeriesDto = S["TvSeriesDto"];
export type TvSeasonDetailsResponse = S["TvSeasonDetailsResponse"];
export type TvSeasonDto = S["TvSeasonDto"];
export type TvEpisodeDto = S["TvEpisodeDto"];

export type ResolveRequest = S["ResolveRequest"];
export type ResolveResponse = S["ResolveResponse"];
export type MediaStreamInfo = S["MediaStreamInfo"];

export type SessionResponse = S["SessionResponse"];
export type MetricsResponse = S["MetricsResponse"];
export type CachedReleaseResponse = S["CachedReleaseResponse"];
export type EphemeralFileResponse = S["EphemeralFileResponse"];
export type StreamingHistoryResponse = S["StreamingHistoryResponse"];
export type ReachabilityStatus = S["ReachabilityStatus"];
