using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Streamarr.Server.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class ViewerDownloadsClientIdentity : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<string>(
                name: "ClientDeviceId",
                table: "ViewerDownloads",
                type: "TEXT",
                nullable: true);

            // Earlier rows only kept the normalized id (ViewerDownloadsDeviceIdentity lowercased it): the closest to what was sent.
            migrationBuilder.Sql("""UPDATE "ViewerDownloads" SET "ClientDeviceId" = "DeviceId" WHERE "DeviceId" IS NOT NULL;""");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropColumn(
                name: "ClientDeviceId",
                table: "ViewerDownloads");
        }
    }
}
