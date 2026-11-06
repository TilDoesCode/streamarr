using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Streamarr.Server.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class ViewerDownloads : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<bool>(
                name: "AllowDownloads",
                table: "Viewers",
                type: "INTEGER",
                nullable: false,
                defaultValue: true);

            migrationBuilder.AddColumn<int>(
                name: "MaxConcurrentDownloads",
                table: "Viewers",
                type: "INTEGER",
                nullable: true);

            migrationBuilder.CreateTable(
                name: "ViewerDownloads",
                columns: table => new
                {
                    Id = table.Column<string>(type: "TEXT", nullable: false),
                    ViewerId = table.Column<string>(type: "TEXT", nullable: false),
                    SessionId = table.Column<string>(type: "TEXT", nullable: false),
                    DeviceName = table.Column<string>(type: "TEXT", nullable: true),
                    DeviceId = table.Column<string>(type: "TEXT", nullable: true),
                    ClientRef = table.Column<string>(type: "TEXT", nullable: true),
                    WorkId = table.Column<string>(type: "TEXT", nullable: false),
                    SeriesWorkId = table.Column<string>(type: "TEXT", nullable: true),
                    Title = table.Column<string>(type: "TEXT", nullable: true),
                    RequestedReleaseId = table.Column<string>(type: "TEXT", nullable: false),
                    ReleaseId = table.Column<string>(type: "TEXT", nullable: true),
                    ReleaseName = table.Column<string>(type: "TEXT", nullable: true),
                    FallbackFromReleaseId = table.Column<string>(type: "TEXT", nullable: true),
                    State = table.Column<string>(type: "TEXT", nullable: false),
                    RequestJson = table.Column<string>(type: "TEXT", nullable: false),
                    ErrorJson = table.Column<string>(type: "TEXT", nullable: true),
                    AttemptsJson = table.Column<string>(type: "TEXT", nullable: true),
                    VersionJson = table.Column<string>(type: "TEXT", nullable: true),
                    MediaInfoJson = table.Column<string>(type: "TEXT", nullable: true),
                    DecisionJson = table.Column<string>(type: "TEXT", nullable: true),
                    Engine = table.Column<string>(type: "TEXT", nullable: true),
                    FileName = table.Column<string>(type: "TEXT", nullable: true),
                    Container = table.Column<string>(type: "TEXT", nullable: true),
                    SizeBytes = table.Column<long>(type: "INTEGER", nullable: true),
                    ETag = table.Column<string>(type: "TEXT", nullable: true),
                    CapabilityHash = table.Column<string>(type: "TEXT", nullable: true),
                    CapabilityProtected = table.Column<string>(type: "TEXT", nullable: true),
                    ExpiresAt = table.Column<long>(type: "INTEGER", nullable: true),
                    BytesServed = table.Column<long>(type: "INTEGER", nullable: false),
                    CreatedAt = table.Column<long>(type: "INTEGER", nullable: false),
                    UpdatedAt = table.Column<long>(type: "INTEGER", nullable: false),
                    ReadyAt = table.Column<long>(type: "INTEGER", nullable: true),
                    CompletedAt = table.Column<long>(type: "INTEGER", nullable: true),
                    LastTransferAt = table.Column<long>(type: "INTEGER", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_ViewerDownloads", x => x.Id);
                    table.ForeignKey(
                        name: "FK_ViewerDownloads_Viewers_ViewerId",
                        column: x => x.ViewerId,
                        principalTable: "Viewers",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateIndex(
                name: "IX_ViewerDownloads_CapabilityHash",
                table: "ViewerDownloads",
                column: "CapabilityHash",
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_ViewerDownloads_State",
                table: "ViewerDownloads",
                column: "State");

            migrationBuilder.CreateIndex(
                name: "IX_ViewerDownloads_ViewerId_CreatedAt",
                table: "ViewerDownloads",
                columns: new[] { "ViewerId", "CreatedAt" });

            migrationBuilder.CreateIndex(
                name: "IX_ViewerDownloads_ViewerId_SessionId_ClientRef",
                table: "ViewerDownloads",
                columns: new[] { "ViewerId", "SessionId", "ClientRef" });
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "ViewerDownloads");

            migrationBuilder.DropColumn(
                name: "AllowDownloads",
                table: "Viewers");

            migrationBuilder.DropColumn(
                name: "MaxConcurrentDownloads",
                table: "Viewers");
        }
    }
}
