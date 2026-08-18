using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Streamarr.Server.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class AddPreDownloadConfig : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<long>(
                name: "DurationTicks",
                table: "WatchEvents",
                type: "INTEGER",
                nullable: false,
                defaultValue: 0L);

            migrationBuilder.AddColumn<string>(
                name: "SessionToken",
                table: "WatchEvents",
                type: "TEXT",
                nullable: false,
                defaultValue: "");

            migrationBuilder.CreateTable(
                name: "PreDownloadConfig",
                columns: table => new
                {
                    Id = table.Column<int>(type: "INTEGER", nullable: false)
                        .Annotation("Sqlite:Autoincrement", true),
                    Enabled = table.Column<bool>(type: "INTEGER", nullable: false),
                    DownloadCurrentFile = table.Column<bool>(type: "INTEGER", nullable: false),
                    CurrentFileThresholdSeconds = table.Column<int>(type: "INTEGER", nullable: false),
                    DownloadNextEpisode = table.Column<bool>(type: "INTEGER", nullable: false),
                    NextEpisodeThresholdPercent = table.Column<int>(type: "INTEGER", nullable: false),
                    MaxConcurrentDownloads = table.Column<int>(type: "INTEGER", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_PreDownloadConfig", x => x.Id);
                });
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "PreDownloadConfig");

            migrationBuilder.DropColumn(
                name: "DurationTicks",
                table: "WatchEvents");

            migrationBuilder.DropColumn(
                name: "SessionToken",
                table: "WatchEvents");
        }
    }
}
