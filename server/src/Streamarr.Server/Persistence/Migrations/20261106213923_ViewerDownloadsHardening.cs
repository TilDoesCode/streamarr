using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Streamarr.Server.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class ViewerDownloadsHardening : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<string>(
                name: "CountedPlaybackIds",
                table: "ViewerWatchStates",
                type: "TEXT",
                nullable: true);

            migrationBuilder.AddColumn<long>(
                name: "CapabilityRevokedAt",
                table: "ViewerDownloads",
                type: "INTEGER",
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "IdempotencyKey",
                table: "ViewerDownloads",
                type: "TEXT",
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "RevokedCapabilityHash",
                table: "ViewerDownloads",
                type: "TEXT",
                nullable: true);

            // The oldest record per (viewer, device, clientRef) keeps the key; hex-encoded fields, so distinct tuples never collide.
            migrationBuilder.Sql(
                """
                UPDATE "ViewerDownloads" SET "IdempotencyKey" = hex("ViewerId") || '|' ||
                    hex(CASE WHEN "DeviceId" IS NOT NULL THEN 'd:' || lower("DeviceId") ELSE 's:' || "SessionId" END)
                    || '|' || hex("ClientRef")
                WHERE "Id" IN (
                    SELECT "Id" FROM (
                        SELECT "Id", ROW_NUMBER() OVER (
                            PARTITION BY "ViewerId",
                                CASE WHEN "DeviceId" IS NOT NULL THEN 'd:' || lower("DeviceId") ELSE 's:' || "SessionId" END,
                                "ClientRef"
                            ORDER BY "CreatedAt", "Id") AS "Rank"
                        FROM "ViewerDownloads" WHERE "ClientRef" IS NOT NULL)
                    WHERE "Rank" = 1)
                """);

            migrationBuilder.CreateIndex(
                name: "IX_ViewerDownloads_IdempotencyKey",
                table: "ViewerDownloads",
                column: "IdempotencyKey",
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_ViewerDownloads_RevokedCapabilityHash",
                table: "ViewerDownloads",
                column: "RevokedCapabilityHash");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropIndex(
                name: "IX_ViewerDownloads_IdempotencyKey",
                table: "ViewerDownloads");

            migrationBuilder.DropIndex(
                name: "IX_ViewerDownloads_RevokedCapabilityHash",
                table: "ViewerDownloads");

            migrationBuilder.DropColumn(
                name: "CountedPlaybackIds",
                table: "ViewerWatchStates");

            migrationBuilder.DropColumn(
                name: "CapabilityRevokedAt",
                table: "ViewerDownloads");

            migrationBuilder.DropColumn(
                name: "IdempotencyKey",
                table: "ViewerDownloads");

            migrationBuilder.DropColumn(
                name: "RevokedCapabilityHash",
                table: "ViewerDownloads");
        }
    }
}
