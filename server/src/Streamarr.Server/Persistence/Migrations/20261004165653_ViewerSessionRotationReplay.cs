using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Streamarr.Server.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class ViewerSessionRotationReplay : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<long>(
                name: "PreviousRefreshExpiresAt",
                table: "ViewerSessions",
                type: "INTEGER",
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "RetiredRefreshTokenHashes",
                table: "ViewerSessions",
                type: "TEXT",
                nullable: true);

            migrationBuilder.AddColumn<long>(
                name: "RotationConfirmedAt",
                table: "ViewerSessions",
                type: "INTEGER",
                nullable: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropColumn(
                name: "PreviousRefreshExpiresAt",
                table: "ViewerSessions");

            migrationBuilder.DropColumn(
                name: "RetiredRefreshTokenHashes",
                table: "ViewerSessions");

            migrationBuilder.DropColumn(
                name: "RotationConfirmedAt",
                table: "ViewerSessions");
        }
    }
}
