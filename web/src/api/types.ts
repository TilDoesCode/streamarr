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
export type PreDownloadConfigResponse = S["PreDownloadConfigResponse"];
export type PreDownloadConfigWrite = S["PreDownloadConfigWrite"];
export type PreDownloadJobResponse = S["PreDownloadJobResponse"];
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

export type RepairOverviewResponse = S["RepairOverviewResponse"];
export type RepairJobResponse = S["RepairJobResponse"];
export type RepairJobEventResponse = S["RepairJobEventResponse"];
export type RepairArtifactResponse = S["RepairArtifactResponse"];
export type RepairMetrics = S["RepairMetrics"];

export type SessionResponse = S["SessionResponse"];
export type TtffSpanResponse = S["TtffSpanResponse"];
export type ArticleMapResponse = S["ArticleMapResponse"];
export type ArticleTelemetryResponse = S["ArticleTelemetryResponse"];
export type ArticleProviderAttemptResponse = S["ArticleProviderAttemptResponse"];
export type ArticleProviderSummaryResponse = S["ArticleProviderSummaryResponse"];
export type MetricsResponse = S["MetricsResponse"];
export type StorageResponse = S["StorageResponse"];
export type CachedReleaseResponse = S["CachedReleaseResponse"];
export type EphemeralFileResponse = S["EphemeralFileResponse"];
export type StreamingHistoryResponse = S["StreamingHistoryResponse"];
export type PlaybackRangeResponse = S["PlaybackRangeResponse"];
export type PlaybackRangeSpanResponse = S["PlaybackRangeSpanResponse"];
export type ByteRangeResponse = S["ByteRangeResponse"];
export type ReachabilityStatus = S["ReachabilityStatus"];

export type StreamRecordSummaryResponse = S["StreamRecordSummaryResponse"];
export type StreamRecordResponse = S["StreamRecordResponse"];
export type StreamEventResponse = S["StreamEventResponse"];

export type LogEntryResponse = S["LogEntryResponse"];
export type LogSourceStatusResponse = S["LogSourceStatusResponse"];
export type LogFeedResponse = S["LogFeedResponse"];
