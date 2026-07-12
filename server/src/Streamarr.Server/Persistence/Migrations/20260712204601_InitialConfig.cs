using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Streamarr.Server.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class InitialConfig : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "ApiKeys",
                columns: table => new
                {
                    Id = table.Column<string>(type: "TEXT", nullable: false),
                    Name = table.Column<string>(type: "TEXT", nullable: false),
                    KeyHash = table.Column<string>(type: "TEXT", nullable: false),
                    Prefix = table.Column<string>(type: "TEXT", nullable: false),
                    CreatedAt = table.Column<DateTimeOffset>(type: "TEXT", nullable: false),
                    RevokedAt = table.Column<DateTimeOffset>(type: "TEXT", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_ApiKeys", x => x.Id);
                });

            migrationBuilder.CreateTable(
                name: "GeneralConfig",
                columns: table => new
                {
                    Id = table.Column<int>(type: "INTEGER", nullable: false)
                        .Annotation("Sqlite:Autoincrement", true),
                    TmdbApiKeyEncrypted = table.Column<string>(type: "TEXT", nullable: true),
                    SessionTtlSeconds = table.Column<int>(type: "INTEGER", nullable: false),
                    SearchCacheTtlSeconds = table.Column<int>(type: "INTEGER", nullable: false),
                    SegmentCacheSizeMb = table.Column<int>(type: "INTEGER", nullable: false),
                    ConnectionBudget = table.Column<int>(type: "INTEGER", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_GeneralConfig", x => x.Id);
                });

            migrationBuilder.CreateTable(
                name: "Indexers",
                columns: table => new
                {
                    Id = table.Column<string>(type: "TEXT", nullable: false),
                    Name = table.Column<string>(type: "TEXT", nullable: false),
                    BaseUrl = table.Column<string>(type: "TEXT", nullable: false),
                    ApiKeyEncrypted = table.Column<string>(type: "TEXT", nullable: true),
                    Categories = table.Column<string>(type: "TEXT", nullable: false),
                    Enabled = table.Column<bool>(type: "INTEGER", nullable: false),
                    Priority = table.Column<int>(type: "INTEGER", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_Indexers", x => x.Id);
                });

            migrationBuilder.CreateTable(
                name: "Profiles",
                columns: table => new
                {
                    Id = table.Column<string>(type: "TEXT", nullable: false),
                    Name = table.Column<string>(type: "TEXT", nullable: false),
                    PayloadJson = table.Column<string>(type: "TEXT", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_Profiles", x => x.Id);
                });

            migrationBuilder.CreateTable(
                name: "Providers",
                columns: table => new
                {
                    Id = table.Column<string>(type: "TEXT", nullable: false),
                    Name = table.Column<string>(type: "TEXT", nullable: false),
                    Host = table.Column<string>(type: "TEXT", nullable: false),
                    Port = table.Column<int>(type: "INTEGER", nullable: false),
                    UseSsl = table.Column<bool>(type: "INTEGER", nullable: false),
                    Username = table.Column<string>(type: "TEXT", nullable: false),
                    PasswordEncrypted = table.Column<string>(type: "TEXT", nullable: true),
                    MaxConnections = table.Column<int>(type: "INTEGER", nullable: false),
                    Priority = table.Column<int>(type: "INTEGER", nullable: false),
                    Enabled = table.Column<bool>(type: "INTEGER", nullable: false),
                    IsBackupOnly = table.Column<bool>(type: "INTEGER", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_Providers", x => x.Id);
                });

            migrationBuilder.CreateTable(
                name: "WatchEvents",
                columns: table => new
                {
                    Id = table.Column<long>(type: "INTEGER", nullable: false)
                        .Annotation("Sqlite:Autoincrement", true),
                    ReleaseId = table.Column<string>(type: "TEXT", nullable: false),
                    WorkId = table.Column<string>(type: "TEXT", nullable: false),
                    Event = table.Column<string>(type: "TEXT", nullable: false),
                    PositionTicks = table.Column<long>(type: "INTEGER", nullable: false),
                    Source = table.Column<string>(type: "TEXT", nullable: false),
                    ReceivedAt = table.Column<DateTimeOffset>(type: "TEXT", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_WatchEvents", x => x.Id);
                });

            migrationBuilder.CreateIndex(
                name: "IX_ApiKeys_KeyHash",
                table: "ApiKeys",
                column: "KeyHash",
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_WatchEvents_ReceivedAt",
                table: "WatchEvents",
                column: "ReceivedAt");

            migrationBuilder.CreateIndex(
                name: "IX_WatchEvents_ReleaseId",
                table: "WatchEvents",
                column: "ReleaseId");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "ApiKeys");

            migrationBuilder.DropTable(
                name: "GeneralConfig");

            migrationBuilder.DropTable(
                name: "Indexers");

            migrationBuilder.DropTable(
                name: "Profiles");

            migrationBuilder.DropTable(
                name: "Providers");

            migrationBuilder.DropTable(
                name: "WatchEvents");
        }
    }
}
