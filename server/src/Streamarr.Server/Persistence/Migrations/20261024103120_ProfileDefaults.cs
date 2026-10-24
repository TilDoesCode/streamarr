using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Streamarr.Server.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class ProfileDefaults : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<string>(
                name: "RankingProfileId",
                table: "Viewers",
                type: "TEXT",
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "DefaultProfileId",
                table: "GeneralConfig",
                type: "TEXT",
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "MovieProfileId",
                table: "GeneralConfig",
                type: "TEXT",
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "SeriesProfileId",
                table: "GeneralConfig",
                type: "TEXT",
                nullable: true);

            migrationBuilder.AddColumn<bool>(
                name: "ViewersMayChooseProfile",
                table: "GeneralConfig",
                type: "INTEGER",
                nullable: false,
                defaultValue: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropColumn(
                name: "RankingProfileId",
                table: "Viewers");

            migrationBuilder.DropColumn(
                name: "DefaultProfileId",
                table: "GeneralConfig");

            migrationBuilder.DropColumn(
                name: "MovieProfileId",
                table: "GeneralConfig");

            migrationBuilder.DropColumn(
                name: "SeriesProfileId",
                table: "GeneralConfig");

            migrationBuilder.DropColumn(
                name: "ViewersMayChooseProfile",
                table: "GeneralConfig");
        }
    }
}
