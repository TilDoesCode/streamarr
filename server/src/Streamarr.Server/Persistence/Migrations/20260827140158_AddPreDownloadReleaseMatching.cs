using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Streamarr.Server.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class AddPreDownloadReleaseMatching : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<int>(
                name: "NextEpisodeReleaseSimilarityThresholdPercent",
                table: "PreDownloadConfig",
                type: "INTEGER",
                nullable: false,
                defaultValue: 75);

            migrationBuilder.AddColumn<bool>(
                name: "PreferSimilarNextEpisodeRelease",
                table: "PreDownloadConfig",
                type: "INTEGER",
                nullable: false,
                defaultValue: false);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropColumn(
                name: "NextEpisodeReleaseSimilarityThresholdPercent",
                table: "PreDownloadConfig");

            migrationBuilder.DropColumn(
                name: "PreferSimilarNextEpisodeRelease",
                table: "PreDownloadConfig");
        }
    }
}
