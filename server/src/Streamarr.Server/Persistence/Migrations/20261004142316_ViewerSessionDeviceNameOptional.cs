using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Streamarr.Server.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class ViewerSessionDeviceNameOptional : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AlterColumn<string>(
                name: "DeviceName",
                table: "ViewerSessions",
                type: "TEXT",
                nullable: true,
                oldClrType: typeof(string),
                oldType: "TEXT");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.Sql("UPDATE \"ViewerSessions\" SET \"DeviceName\" = '' WHERE \"DeviceName\" IS NULL;");

            migrationBuilder.AlterColumn<string>(
                name: "DeviceName",
                table: "ViewerSessions",
                type: "TEXT",
                nullable: false,
                defaultValue: "",
                oldClrType: typeof(string),
                oldType: "TEXT",
                oldNullable: true);
        }
    }
}
