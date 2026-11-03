using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Streamarr.Server.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class AddTunnels : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<string>(
                name: "TunnelId",
                table: "Providers",
                type: "TEXT",
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "TunnelId",
                table: "Indexers",
                type: "TEXT",
                nullable: true);

            migrationBuilder.CreateTable(
                name: "Tunnels",
                columns: table => new
                {
                    Id = table.Column<string>(type: "TEXT", nullable: false),
                    Name = table.Column<string>(type: "TEXT", nullable: false),
                    Preset = table.Column<string>(type: "TEXT", nullable: false),
                    Enabled = table.Column<bool>(type: "INTEGER", nullable: false),
                    Endpoint = table.Column<string>(type: "TEXT", nullable: false),
                    Addresses = table.Column<string>(type: "TEXT", nullable: false),
                    Dns = table.Column<string>(type: "TEXT", nullable: false),
                    Mtu = table.Column<int>(type: "INTEGER", nullable: true),
                    Keepalive = table.Column<int>(type: "INTEGER", nullable: true),
                    PeerPublicKey = table.Column<string>(type: "TEXT", nullable: false),
                    PrivateKeyEncrypted = table.Column<string>(type: "TEXT", nullable: true),
                    PresharedKeyEncrypted = table.Column<string>(type: "TEXT", nullable: true),
                    AllowedIps = table.Column<string>(type: "TEXT", nullable: false),
                    LocalPort = table.Column<int>(type: "INTEGER", nullable: false),
                    CreatedAt = table.Column<DateTimeOffset>(type: "TEXT", nullable: false),
                    UpdatedAt = table.Column<DateTimeOffset>(type: "TEXT", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_Tunnels", x => x.Id);
                });

            migrationBuilder.CreateIndex(
                name: "IX_Providers_TunnelId",
                table: "Providers",
                column: "TunnelId");

            migrationBuilder.CreateIndex(
                name: "IX_Indexers_TunnelId",
                table: "Indexers",
                column: "TunnelId");

            migrationBuilder.CreateIndex(
                name: "IX_Tunnels_LocalPort",
                table: "Tunnels",
                column: "LocalPort",
                unique: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "Tunnels");

            migrationBuilder.DropIndex(
                name: "IX_Providers_TunnelId",
                table: "Providers");

            migrationBuilder.DropIndex(
                name: "IX_Indexers_TunnelId",
                table: "Indexers");

            migrationBuilder.DropColumn(
                name: "TunnelId",
                table: "Providers");

            migrationBuilder.DropColumn(
                name: "TunnelId",
                table: "Indexers");
        }
    }
}
