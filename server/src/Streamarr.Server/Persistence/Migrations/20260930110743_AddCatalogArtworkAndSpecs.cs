using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Streamarr.Server.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class AddCatalogArtworkAndSpecs : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "ArtworkPalettes",
                columns: table => new
                {
                    ImageUrl = table.Column<string>(type: "TEXT", nullable: false),
                    Tint = table.Column<string>(type: "TEXT", nullable: true),
                    Tint2 = table.Column<string>(type: "TEXT", nullable: true),
                    ComputedAt = table.Column<long>(type: "INTEGER", nullable: false),
                    Version = table.Column<int>(type: "INTEGER", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_ArtworkPalettes", x => x.ImageUrl);
                });

            migrationBuilder.CreateTable(
                name: "CatalogSpecSummaries",
                columns: table => new
                {
                    WorkId = table.Column<string>(type: "TEXT", nullable: false),
                    Resolution = table.Column<string>(type: "TEXT", nullable: true),
                    Hdr = table.Column<string>(type: "TEXT", nullable: true),
                    VideoCodec = table.Column<string>(type: "TEXT", nullable: true),
                    Audio = table.Column<string>(type: "TEXT", nullable: true),
                    UpdatedAt = table.Column<long>(type: "INTEGER", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_CatalogSpecSummaries", x => x.WorkId);
                });
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "ArtworkPalettes");

            migrationBuilder.DropTable(
                name: "CatalogSpecSummaries");
        }
    }
}
