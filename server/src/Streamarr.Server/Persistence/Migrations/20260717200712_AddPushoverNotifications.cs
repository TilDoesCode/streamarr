using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Streamarr.Server.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class AddPushoverNotifications : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "NotificationConfig",
                columns: table => new
                {
                    Id = table.Column<int>(type: "INTEGER", nullable: false)
                        .Annotation("Sqlite:Autoincrement", true),
                    Enabled = table.Column<bool>(type: "INTEGER", nullable: false),
                    AppTokenEncrypted = table.Column<string>(type: "TEXT", nullable: true),
                    UserKeyEncrypted = table.Column<string>(type: "TEXT", nullable: true),
                    Device = table.Column<string>(type: "TEXT", nullable: false),
                    Sound = table.Column<string>(type: "TEXT", nullable: false),
                    NotifyApplicationStarted = table.Column<bool>(type: "INTEGER", nullable: false),
                    NotifyPlaybackStarted = table.Column<bool>(type: "INTEGER", nullable: false),
                    NotifyPlaybackProgress = table.Column<bool>(type: "INTEGER", nullable: false),
                    NotifyPlaybackStopped = table.Column<bool>(type: "INTEGER", nullable: false),
                    NotifyResolveSucceeded = table.Column<bool>(type: "INTEGER", nullable: false),
                    NotifyResolveFailed = table.Column<bool>(type: "INTEGER", nullable: false),
                    NotifyErrors = table.Column<bool>(type: "INTEGER", nullable: false),
                    NotifyOutages = table.Column<bool>(type: "INTEGER", nullable: false),
                    NotifyRecoveries = table.Column<bool>(type: "INTEGER", nullable: false),
                    IncludeUserName = table.Column<bool>(type: "INTEGER", nullable: false),
                    IncludeDeviceName = table.Column<bool>(type: "INTEGER", nullable: false),
                    IncludeReleaseId = table.Column<bool>(type: "INTEGER", nullable: false),
                    UsagePriority = table.Column<int>(type: "INTEGER", nullable: false),
                    ErrorPriority = table.Column<int>(type: "INTEGER", nullable: false),
                    OutagePriority = table.Column<int>(type: "INTEGER", nullable: false),
                    RecoveryPriority = table.Column<int>(type: "INTEGER", nullable: false),
                    ProgressIntervalMinutes = table.Column<int>(type: "INTEGER", nullable: false),
                    ErrorCooldownSeconds = table.Column<int>(type: "INTEGER", nullable: false),
                    MonitorIntervalSeconds = table.Column<int>(type: "INTEGER", nullable: false),
                    OutageFailureThreshold = table.Column<int>(type: "INTEGER", nullable: false),
                    OutageReminderMinutes = table.Column<int>(type: "INTEGER", nullable: false),
                    EmergencyRetrySeconds = table.Column<int>(type: "INTEGER", nullable: false),
                    EmergencyExpireSeconds = table.Column<int>(type: "INTEGER", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_NotificationConfig", x => x.Id);
                });
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "NotificationConfig");
        }
    }
}
