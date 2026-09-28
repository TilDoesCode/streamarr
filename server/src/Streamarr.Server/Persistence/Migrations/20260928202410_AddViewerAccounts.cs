using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Streamarr.Server.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class AddViewerAccounts : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "ViewerConfig",
                columns: table => new
                {
                    Id = table.Column<int>(type: "INTEGER", nullable: false)
                        .Annotation("Sqlite:Autoincrement", true),
                    SettingsJson = table.Column<string>(type: "TEXT", nullable: false),
                    SmtpPasswordEncrypted = table.Column<string>(type: "TEXT", nullable: true),
                    UpdatedAt = table.Column<long>(type: "INTEGER", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_ViewerConfig", x => x.Id);
                });

            migrationBuilder.CreateTable(
                name: "Viewers",
                columns: table => new
                {
                    Id = table.Column<string>(type: "TEXT", nullable: false),
                    Username = table.Column<string>(type: "TEXT", nullable: false),
                    NormalizedUsername = table.Column<string>(type: "TEXT", nullable: false),
                    DisplayName = table.Column<string>(type: "TEXT", nullable: false),
                    Email = table.Column<string>(type: "TEXT", nullable: true),
                    NormalizedEmail = table.Column<string>(type: "TEXT", nullable: true),
                    EmailVerifiedAt = table.Column<long>(type: "INTEGER", nullable: true),
                    PendingEmail = table.Column<string>(type: "TEXT", nullable: true),
                    PasswordHash = table.Column<string>(type: "TEXT", nullable: false),
                    PasswordSalt = table.Column<string>(type: "TEXT", nullable: false),
                    MustChangePassword = table.Column<bool>(type: "INTEGER", nullable: false),
                    PasswordChangedAt = table.Column<long>(type: "INTEGER", nullable: true),
                    IsDisabled = table.Column<bool>(type: "INTEGER", nullable: false),
                    MaxAge = table.Column<int>(type: "INTEGER", nullable: true),
                    BlockUnrated = table.Column<bool>(type: "INTEGER", nullable: false),
                    AllowTranscoding = table.Column<bool>(type: "INTEGER", nullable: false),
                    MaxConcurrentStreams = table.Column<int>(type: "INTEGER", nullable: true),
                    TotpSecretEncrypted = table.Column<string>(type: "TEXT", nullable: true),
                    PendingTotpSecretEncrypted = table.Column<string>(type: "TEXT", nullable: true),
                    TotpEnabledAt = table.Column<long>(type: "INTEGER", nullable: true),
                    TotpLastUsedStep = table.Column<long>(type: "INTEGER", nullable: true),
                    FailedLoginCount = table.Column<int>(type: "INTEGER", nullable: false),
                    LockoutEndsAt = table.Column<long>(type: "INTEGER", nullable: true),
                    CreatedAt = table.Column<long>(type: "INTEGER", nullable: false),
                    UpdatedAt = table.Column<long>(type: "INTEGER", nullable: false),
                    LastLoginAt = table.Column<long>(type: "INTEGER", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_Viewers", x => x.Id);
                });

            migrationBuilder.CreateTable(
                name: "ViewerOneTimeCodes",
                columns: table => new
                {
                    Id = table.Column<string>(type: "TEXT", nullable: false),
                    ViewerId = table.Column<string>(type: "TEXT", nullable: false),
                    Purpose = table.Column<string>(type: "TEXT", nullable: false),
                    CodeHash = table.Column<string>(type: "TEXT", nullable: false),
                    Salt = table.Column<string>(type: "TEXT", nullable: false),
                    Target = table.Column<string>(type: "TEXT", nullable: true),
                    Attempts = table.Column<int>(type: "INTEGER", nullable: false),
                    CreatedAt = table.Column<long>(type: "INTEGER", nullable: false),
                    ExpiresAt = table.Column<long>(type: "INTEGER", nullable: false),
                    ConsumedAt = table.Column<long>(type: "INTEGER", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_ViewerOneTimeCodes", x => x.Id);
                    table.ForeignKey(
                        name: "FK_ViewerOneTimeCodes_Viewers_ViewerId",
                        column: x => x.ViewerId,
                        principalTable: "Viewers",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "ViewerRecoveryCodes",
                columns: table => new
                {
                    Id = table.Column<long>(type: "INTEGER", nullable: false)
                        .Annotation("Sqlite:Autoincrement", true),
                    ViewerId = table.Column<string>(type: "TEXT", nullable: false),
                    CodeHash = table.Column<string>(type: "TEXT", nullable: false),
                    CreatedAt = table.Column<long>(type: "INTEGER", nullable: false),
                    UsedAt = table.Column<long>(type: "INTEGER", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_ViewerRecoveryCodes", x => x.Id);
                    table.ForeignKey(
                        name: "FK_ViewerRecoveryCodes_Viewers_ViewerId",
                        column: x => x.ViewerId,
                        principalTable: "Viewers",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "ViewerSessions",
                columns: table => new
                {
                    Id = table.Column<string>(type: "TEXT", nullable: false),
                    ViewerId = table.Column<string>(type: "TEXT", nullable: false),
                    AccessTokenHash = table.Column<string>(type: "TEXT", nullable: false),
                    AccessExpiresAt = table.Column<long>(type: "INTEGER", nullable: false),
                    RefreshTokenHash = table.Column<string>(type: "TEXT", nullable: false),
                    PreviousRefreshTokenHash = table.Column<string>(type: "TEXT", nullable: true),
                    RotatedAt = table.Column<long>(type: "INTEGER", nullable: true),
                    RotatedTokensEncrypted = table.Column<string>(type: "TEXT", nullable: true),
                    RefreshExpiresAt = table.Column<long>(type: "INTEGER", nullable: false),
                    DeviceName = table.Column<string>(type: "TEXT", nullable: false),
                    ClientName = table.Column<string>(type: "TEXT", nullable: false),
                    AuthMethod = table.Column<string>(type: "TEXT", nullable: false),
                    CookieMode = table.Column<bool>(type: "INTEGER", nullable: false),
                    IpAddress = table.Column<string>(type: "TEXT", nullable: true),
                    CreatedAt = table.Column<long>(type: "INTEGER", nullable: false),
                    LastSeenAt = table.Column<long>(type: "INTEGER", nullable: false),
                    RevokedAt = table.Column<long>(type: "INTEGER", nullable: true),
                    RevokedReason = table.Column<string>(type: "TEXT", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_ViewerSessions", x => x.Id);
                    table.ForeignKey(
                        name: "FK_ViewerSessions_Viewers_ViewerId",
                        column: x => x.ViewerId,
                        principalTable: "Viewers",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "ViewerWatchStates",
                columns: table => new
                {
                    Id = table.Column<long>(type: "INTEGER", nullable: false)
                        .Annotation("Sqlite:Autoincrement", true),
                    ViewerId = table.Column<string>(type: "TEXT", nullable: false),
                    WorkId = table.Column<string>(type: "TEXT", nullable: false),
                    Kind = table.Column<string>(type: "TEXT", nullable: false),
                    TmdbId = table.Column<int>(type: "INTEGER", nullable: true),
                    SeriesWorkId = table.Column<string>(type: "TEXT", nullable: true),
                    SeasonNumber = table.Column<int>(type: "INTEGER", nullable: true),
                    EpisodeNumber = table.Column<int>(type: "INTEGER", nullable: true),
                    Title = table.Column<string>(type: "TEXT", nullable: true),
                    PositionTicks = table.Column<long>(type: "INTEGER", nullable: false),
                    DurationTicks = table.Column<long>(type: "INTEGER", nullable: true),
                    Played = table.Column<bool>(type: "INTEGER", nullable: false),
                    PlayCount = table.Column<int>(type: "INTEGER", nullable: false),
                    LastReleaseId = table.Column<string>(type: "TEXT", nullable: true),
                    LastPlaybackId = table.Column<string>(type: "TEXT", nullable: true),
                    CountedPlaybackId = table.Column<string>(type: "TEXT", nullable: true),
                    LastPlayedAt = table.Column<long>(type: "INTEGER", nullable: true),
                    PlayedAt = table.Column<long>(type: "INTEGER", nullable: true),
                    UpdatedAt = table.Column<long>(type: "INTEGER", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_ViewerWatchStates", x => x.Id);
                    table.ForeignKey(
                        name: "FK_ViewerWatchStates_Viewers_ViewerId",
                        column: x => x.ViewerId,
                        principalTable: "Viewers",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateIndex(
                name: "IX_ViewerOneTimeCodes_ViewerId_Purpose",
                table: "ViewerOneTimeCodes",
                columns: new[] { "ViewerId", "Purpose" });

            migrationBuilder.CreateIndex(
                name: "IX_ViewerRecoveryCodes_ViewerId",
                table: "ViewerRecoveryCodes",
                column: "ViewerId");

            migrationBuilder.CreateIndex(
                name: "IX_Viewers_NormalizedEmail",
                table: "Viewers",
                column: "NormalizedEmail",
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_Viewers_NormalizedUsername",
                table: "Viewers",
                column: "NormalizedUsername",
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_ViewerSessions_AccessTokenHash",
                table: "ViewerSessions",
                column: "AccessTokenHash",
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_ViewerSessions_PreviousRefreshTokenHash",
                table: "ViewerSessions",
                column: "PreviousRefreshTokenHash");

            migrationBuilder.CreateIndex(
                name: "IX_ViewerSessions_RefreshTokenHash",
                table: "ViewerSessions",
                column: "RefreshTokenHash",
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_ViewerSessions_ViewerId",
                table: "ViewerSessions",
                column: "ViewerId");

            migrationBuilder.CreateIndex(
                name: "IX_ViewerWatchStates_ViewerId_LastPlayedAt",
                table: "ViewerWatchStates",
                columns: new[] { "ViewerId", "LastPlayedAt" });

            migrationBuilder.CreateIndex(
                name: "IX_ViewerWatchStates_ViewerId_SeriesWorkId",
                table: "ViewerWatchStates",
                columns: new[] { "ViewerId", "SeriesWorkId" });

            migrationBuilder.CreateIndex(
                name: "IX_ViewerWatchStates_ViewerId_WorkId",
                table: "ViewerWatchStates",
                columns: new[] { "ViewerId", "WorkId" },
                unique: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "ViewerConfig");

            migrationBuilder.DropTable(
                name: "ViewerOneTimeCodes");

            migrationBuilder.DropTable(
                name: "ViewerRecoveryCodes");

            migrationBuilder.DropTable(
                name: "ViewerSessions");

            migrationBuilder.DropTable(
                name: "ViewerWatchStates");

            migrationBuilder.DropTable(
                name: "Viewers");
        }
    }
}
