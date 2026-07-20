using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Streamarr.Server.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class AddMediaProbeCache : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<DateTimeOffset>(
                name: "MediaProbeCachedAt",
                table: "CachedReleases",
                type: "TEXT",
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "MediaProbeJson",
                table: "CachedReleases",
                type: "TEXT",
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "MediaProbeKey",
                table: "CachedReleases",
                type: "TEXT",
                nullable: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropColumn(
                name: "MediaProbeCachedAt",
                table: "CachedReleases");

            migrationBuilder.DropColumn(
                name: "MediaProbeJson",
                table: "CachedReleases");

            migrationBuilder.DropColumn(
                name: "MediaProbeKey",
                table: "CachedReleases");
        }
    }
}
