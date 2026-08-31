using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Streamarr.Server.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class AddPlaybackRanges : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "PlaybackRanges",
                columns: table => new
                {
                    Id = table.Column<long>(type: "INTEGER", nullable: false)
                        .Annotation("Sqlite:Autoincrement", true),
                    ScopeKey = table.Column<string>(type: "TEXT", nullable: false),
                    WorkId = table.Column<string>(type: "TEXT", nullable: false),
                    Title = table.Column<string>(type: "TEXT", nullable: false),
                    Source = table.Column<string>(type: "TEXT", nullable: false),
                    PlaybackSessionId = table.Column<string>(type: "TEXT", nullable: false),
                    ExternalUserId = table.Column<string>(type: "TEXT", nullable: false),
                    ExternalUserName = table.Column<string>(type: "TEXT", nullable: false),
                    DeviceName = table.Column<string>(type: "TEXT", nullable: false),
                    DurationTicks = table.Column<long>(type: "INTEGER", nullable: false),
                    PositionTicks = table.Column<long>(type: "INTEGER", nullable: false),
                    LastSessionToken = table.Column<string>(type: "TEXT", nullable: false),
                    LastReleaseId = table.Column<string>(type: "TEXT", nullable: false),
                    RangesJson = table.Column<string>(type: "TEXT", nullable: false),
                    StartedAt = table.Column<DateTimeOffset>(type: "TEXT", nullable: false),
                    UpdatedAt = table.Column<DateTimeOffset>(type: "TEXT", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_PlaybackRanges", x => x.Id);
                });

            migrationBuilder.CreateIndex(
                name: "IX_PlaybackRanges_ScopeKey",
                table: "PlaybackRanges",
                column: "ScopeKey",
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_PlaybackRanges_UpdatedAt",
                table: "PlaybackRanges",
                column: "UpdatedAt");

            migrationBuilder.CreateIndex(
                name: "IX_PlaybackRanges_WorkId",
                table: "PlaybackRanges",
                column: "WorkId");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "PlaybackRanges");
        }
    }
}
