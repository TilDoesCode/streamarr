using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Streamarr.Server.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class ViewerDownloadsDeviceIdentity : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            // Stored device ids take the form every comparison uses (ViewerDownloadService.DeviceIdOf: ASCII letters lowercased).
            migrationBuilder.Sql("""UPDATE "ViewerDownloads" SET "DeviceId" = lower("DeviceId") WHERE "DeviceId" IS NOT NULL;""");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {

        }
    }
}
