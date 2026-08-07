using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Streamarr.Server.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class AddStreamHistory : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "StreamRecords",
                columns: table => new
                {
                    Id = table.Column<long>(type: "INTEGER", nullable: false)
                        .Annotation("Sqlite:Autoincrement", true),
                    AttemptId = table.Column<string>(type: "TEXT", nullable: false),
                    Token = table.Column<string>(type: "TEXT", nullable: true),
                    ReleaseId = table.Column<string>(type: "TEXT", nullable: false),
                    WorkId = table.Column<string>(type: "TEXT", nullable: false),
                    Title = table.Column<string>(type: "TEXT", nullable: true),
                    Container = table.Column<string>(type: "TEXT", nullable: true),
                    SizeBytes = table.Column<long>(type: "INTEGER", nullable: true),
                    BytesServed = table.Column<long>(type: "INTEGER", nullable: false),
                    NntpCommandsTotal = table.Column<long>(type: "INTEGER", nullable: false),
                    Client = table.Column<string>(type: "TEXT", nullable: true),
                    RequestedById = table.Column<string>(type: "TEXT", nullable: true),
                    RequestedByName = table.Column<string>(type: "TEXT", nullable: true),
                    CreatedAt = table.Column<DateTimeOffset>(type: "TEXT", nullable: false),
                    ClosedAt = table.Column<DateTimeOffset>(type: "TEXT", nullable: true),
                    FinalState = table.Column<string>(type: "TEXT", nullable: true),
                    CloseReason = table.Column<string>(type: "TEXT", nullable: true),
                    TimelineStartedAt = table.Column<DateTimeOffset>(type: "TEXT", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_StreamRecords", x => x.Id);
                });

            migrationBuilder.CreateTable(
                name: "StreamEvents",
                columns: table => new
                {
                    Id = table.Column<long>(type: "INTEGER", nullable: false)
                        .Annotation("Sqlite:Autoincrement", true),
                    StreamRecordId = table.Column<long>(type: "INTEGER", nullable: false),
                    AtUtc = table.Column<DateTimeOffset>(type: "TEXT", nullable: false),
                    Source = table.Column<string>(type: "TEXT", nullable: false),
                    Category = table.Column<string>(type: "TEXT", nullable: false),
                    Name = table.Column<string>(type: "TEXT", nullable: false),
                    Detail = table.Column<string>(type: "TEXT", nullable: true),
                    StartMs = table.Column<double>(type: "REAL", nullable: true),
                    DurationMs = table.Column<double>(type: "REAL", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_StreamEvents", x => x.Id);
                    table.ForeignKey(
                        name: "FK_StreamEvents_StreamRecords_StreamRecordId",
                        column: x => x.StreamRecordId,
                        principalTable: "StreamRecords",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateIndex(
                name: "IX_StreamEvents_StreamRecordId",
                table: "StreamEvents",
                column: "StreamRecordId");

            migrationBuilder.CreateIndex(
                name: "IX_StreamRecords_AttemptId",
                table: "StreamRecords",
                column: "AttemptId",
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_StreamRecords_CreatedAt",
                table: "StreamRecords",
                column: "CreatedAt");

            migrationBuilder.CreateIndex(
                name: "IX_StreamRecords_FinalState",
                table: "StreamRecords",
                column: "FinalState");

            migrationBuilder.CreateIndex(
                name: "IX_StreamRecords_Token",
                table: "StreamRecords",
                column: "Token",
                unique: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "StreamEvents");

            migrationBuilder.DropTable(
                name: "StreamRecords");
        }
    }
}
