using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Streamarr.Server.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class ViewerDownloadsLifecycle : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropIndex(
                name: "IX_ViewerDownloads_IdempotencyKey",
                table: "ViewerDownloads");

            migrationBuilder.RenameColumn(
                name: "IdempotencyKey",
                table: "ViewerDownloads",
                newName: "DeviceKey");

            migrationBuilder.AddColumn<long>(
                name: "SecurityGeneration",
                table: "Viewers",
                type: "INTEGER",
                nullable: false,
                defaultValue: 0L);

            migrationBuilder.AddColumn<long>(
                name: "Revision",
                table: "ViewerDownloads",
                type: "INTEGER",
                nullable: false,
                defaultValue: 0L);

            migrationBuilder.AddColumn<long>(
                name: "SecurityGeneration",
                table: "ViewerDownloads",
                type: "INTEGER",
                nullable: false,
                defaultValue: 0L);

            // Same normalization as ViewerDownloadService.DeviceKey (SQLite lower() folds ASCII only); the oldest duplicate keeps the key.
            migrationBuilder.Sql(
                """
                UPDATE "ViewerDownloads" SET "DeviceKey" = NULL;
                UPDATE "ViewerDownloads"
                SET "DeviceKey" = CASE WHEN "DeviceId" IS NOT NULL THEN 'd:' || lower("DeviceId") ELSE 's:' || "SessionId" END
                WHERE "Id" IN (
                    SELECT "Id" FROM (
                        SELECT "Id", ROW_NUMBER() OVER (
                            PARTITION BY "ViewerId",
                                CASE WHEN "DeviceId" IS NOT NULL THEN 'd:' || lower("DeviceId") ELSE 's:' || "SessionId" END,
                                "ClientRef"
                            ORDER BY "CreatedAt", "Id") AS "Rank"
                        FROM "ViewerDownloads" WHERE "ClientRef" IS NOT NULL)
                    WHERE "Rank" = 1);
                """);

            migrationBuilder.CreateIndex(
                name: "IX_ViewerDownloads_ViewerId_DeviceKey_ClientRef",
                table: "ViewerDownloads",
                columns: new[] { "ViewerId", "DeviceKey", "ClientRef" },
                unique: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropIndex(
                name: "IX_ViewerDownloads_ViewerId_DeviceKey_ClientRef",
                table: "ViewerDownloads");

            migrationBuilder.DropColumn(
                name: "SecurityGeneration",
                table: "Viewers");

            migrationBuilder.DropColumn(
                name: "Revision",
                table: "ViewerDownloads");

            migrationBuilder.DropColumn(
                name: "SecurityGeneration",
                table: "ViewerDownloads");

            migrationBuilder.RenameColumn(
                name: "DeviceKey",
                table: "ViewerDownloads",
                newName: "IdempotencyKey");

            migrationBuilder.CreateIndex(
                name: "IX_ViewerDownloads_IdempotencyKey",
                table: "ViewerDownloads",
                column: "IdempotencyKey",
                unique: true);
        }
    }
}
