using System;
using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Streamarr.Server.Persistence.Migrations;

[DbContext(typeof(StreamarrDbContext))]
[Migration("20260717120000_AddCacheAndStreamingAttribution")]
public partial class AddCacheAndStreamingAttribution : Migration
{
    protected override void Up(MigrationBuilder migrationBuilder)
    {
        migrationBuilder.AddColumn<string>("DeviceName", "WatchEvents", "TEXT", nullable: false, defaultValue: "");
        migrationBuilder.AddColumn<string>("ExternalUserId", "WatchEvents", "TEXT", nullable: false, defaultValue: "");
        migrationBuilder.AddColumn<string>("ExternalUserName", "WatchEvents", "TEXT", nullable: false, defaultValue: "");
        migrationBuilder.AddColumn<string>("PlaybackSessionId", "WatchEvents", "TEXT", nullable: false, defaultValue: "");
        migrationBuilder.CreateIndex(
            name: "IX_WatchEvents_PlaybackSessionId",
            table: "WatchEvents",
            column: "PlaybackSessionId");

        migrationBuilder.CreateTable(
            name: "CachedReleases",
            columns: table => new
            {
                ReleaseId = table.Column<string>(type: "TEXT", nullable: false),
                WorkId = table.Column<string>(type: "TEXT", nullable: false),
                Title = table.Column<string>(type: "TEXT", nullable: false),
                Indexer = table.Column<string>(type: "TEXT", nullable: false),
                CacheFileName = table.Column<string>(type: "TEXT", nullable: false),
                ReleaseSizeBytes = table.Column<long>(type: "INTEGER", nullable: false),
                NzbSizeBytes = table.Column<long>(type: "INTEGER", nullable: false),
                FileCount = table.Column<int>(type: "INTEGER", nullable: false),
                SegmentCount = table.Column<int>(type: "INTEGER", nullable: false),
                HitCount = table.Column<long>(type: "INTEGER", nullable: false),
                CachedAt = table.Column<DateTimeOffset>(type: "TEXT", nullable: false),
                LastAccessedAt = table.Column<DateTimeOffset>(type: "TEXT", nullable: false),
            },
            constraints: table => table.PrimaryKey("PK_CachedReleases", x => x.ReleaseId));

        migrationBuilder.CreateIndex(
            name: "IX_CachedReleases_LastAccessedAt",
            table: "CachedReleases",
            column: "LastAccessedAt");
    }

    protected override void Down(MigrationBuilder migrationBuilder)
    {
        migrationBuilder.DropTable("CachedReleases");
        migrationBuilder.DropIndex("IX_WatchEvents_PlaybackSessionId", "WatchEvents");
        migrationBuilder.DropColumn("DeviceName", "WatchEvents");
        migrationBuilder.DropColumn("ExternalUserId", "WatchEvents");
        migrationBuilder.DropColumn("ExternalUserName", "WatchEvents");
        migrationBuilder.DropColumn("PlaybackSessionId", "WatchEvents");
    }
}
