using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Streamarr.Server.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class ClearUnknownViewerDeviceNames : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.Sql("UPDATE \"ViewerSessions\" SET \"DeviceName\" = NULL WHERE \"DeviceName\" = 'Unknown device' OR \"DeviceName\" = '';");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
        }
    }
}
