using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Streamarr.Server.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class ViewerMyList : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<bool>(
                name: "NotifyNewEpisodes",
                table: "NotificationConfig",
                type: "INTEGER",
                nullable: false,
                defaultValue: false);

            migrationBuilder.CreateTable(
                name: "ViewerListEntries",
                columns: table => new
                {
                    Id = table.Column<long>(type: "INTEGER", nullable: false)
                        .Annotation("Sqlite:Autoincrement", true),
                    ViewerId = table.Column<string>(type: "TEXT", nullable: false),
                    WorkId = table.Column<string>(type: "TEXT", nullable: false),
                    Kind = table.Column<string>(type: "TEXT", nullable: false),
                    TmdbId = table.Column<int>(type: "INTEGER", nullable: false),
                    SeriesWorkId = table.Column<string>(type: "TEXT", nullable: true),
                    SeasonNumber = table.Column<int>(type: "INTEGER", nullable: true),
                    Source = table.Column<string>(type: "TEXT", nullable: false),
                    Dismissed = table.Column<bool>(type: "INTEGER", nullable: false),
                    StatusOverride = table.Column<string>(type: "TEXT", nullable: true),
                    StatusOverrideAt = table.Column<long>(type: "INTEGER", nullable: true),
                    NewAvailableSince = table.Column<long>(type: "INTEGER", nullable: true),
                    NewEpisodeWorkId = table.Column<string>(type: "TEXT", nullable: true),
                    LastNotifiedEpisodeWorkId = table.Column<string>(type: "TEXT", nullable: true),
                    PendingEpisodeWorkId = table.Column<string>(type: "TEXT", nullable: true),
                    SeenAt = table.Column<long>(type: "INTEGER", nullable: true),
                    FinishedCheckedAt = table.Column<long>(type: "INTEGER", nullable: true),
                    AddedAt = table.Column<long>(type: "INTEGER", nullable: false),
                    UpdatedAt = table.Column<long>(type: "INTEGER", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_ViewerListEntries", x => x.Id);
                    table.ForeignKey(
                        name: "FK_ViewerListEntries_Viewers_ViewerId",
                        column: x => x.ViewerId,
                        principalTable: "Viewers",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateIndex(
                name: "IX_ViewerListEntries_Kind_Dismissed",
                table: "ViewerListEntries",
                columns: new[] { "Kind", "Dismissed" });

            migrationBuilder.CreateIndex(
                name: "IX_ViewerListEntries_ViewerId_SeriesWorkId",
                table: "ViewerListEntries",
                columns: new[] { "ViewerId", "SeriesWorkId" });

            migrationBuilder.CreateIndex(
                name: "IX_ViewerListEntries_ViewerId_WorkId",
                table: "ViewerListEntries",
                columns: new[] { "ViewerId", "WorkId" },
                unique: true);

            // Backfill: every series a viewer already started is on their list (source auto).
            migrationBuilder.Sql(
                """
                INSERT OR IGNORE INTO "ViewerListEntries"
                    ("ViewerId", "WorkId", "Kind", "TmdbId", "SeriesWorkId", "Source", "Dismissed", "AddedAt", "UpdatedAt")
                SELECT "ViewerId", "SeriesWorkId", 'series', MIN("TmdbId"), "SeriesWorkId", 'auto', 0,
                       MIN(COALESCE("LastPlayedAt", "UpdatedAt")), MAX("UpdatedAt")
                FROM "ViewerWatchStates"
                WHERE "Kind" = 'episode' AND "SeriesWorkId" IS NOT NULL AND "TmdbId" IS NOT NULL
                      AND ("Played" = 1 OR "PositionTicks" > 0 OR "LastPlayedAt" IS NOT NULL)
                GROUP BY "ViewerId", "SeriesWorkId";
                """);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "ViewerListEntries");

            migrationBuilder.DropColumn(
                name: "NotifyNewEpisodes",
                table: "NotificationConfig");
        }
    }
}
