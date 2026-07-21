using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Streamarr.Server.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class AddEphemeralCacheBudget : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<int>(
                name: "EphemeralCacheSizeMb",
                table: "GeneralConfig",
                type: "INTEGER",
                nullable: false,
                defaultValue: 102400);

            // The former 3600-second value was an idle/sliding timeout. It is too short now
            // that the same setting is a hard maximum age and would terminate ordinary films.
            // Preserve any explicitly non-default operator value.
            migrationBuilder.Sql(
                "UPDATE GeneralConfig SET SessionTtlSeconds = 86400 WHERE SessionTtlSeconds = 3600;");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropColumn(
                name: "EphemeralCacheSizeMb",
                table: "GeneralConfig");
        }
    }
}
