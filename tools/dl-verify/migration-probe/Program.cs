using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;
using Streamarr.Server.Persistence;
using System.Text.Json;

var root = Directory.GetCurrentDirectory();
var path = Path.Combine(root, "tools/dl-verify/round3-old-hardening.db");
var seed = args.Contains("--seed-old");
if (seed) File.Delete(path);
await using (var db = new StreamarrDbContext(new DbContextOptionsBuilder<StreamarrDbContext>().UseSqlite($"Data Source={path}").Options))
{
    if (seed)
    {
        // Running under the archived assembly executes the ORIGINAL hardening migration.
        await db.Database.MigrateAsync();
        await InsertViewer(db);
        await InsertRows(db, true);
        Console.WriteLine("SEEDED_ORIGINAL_HARDENING " + JsonSerializer.Serialize(await db.Database.GetAppliedMigrationsAsync()));
    }
    else
    {
        await db.Database.MigrateAsync();
        await Dump(db, "UPGRADE_OLD_HARDENING");
    }
}
if (seed) return;

var fresh = Path.Combine(root, "tools/dl-verify/round3-pre-dl.db");
File.Delete(fresh);
await using (var db = new StreamarrDbContext(new DbContextOptionsBuilder<StreamarrDbContext>().UseSqlite($"Data Source={fresh}").Options))
{
    var migrations = db.Database.GetMigrations().ToArray();
    var dl = Array.FindIndex(migrations, x => x.EndsWith("_ViewerDownloads"));
    await db.GetService<IMigrator>().MigrateAsync(migrations[dl - 1]);
    await InsertViewer(db);
    await db.GetService<IMigrator>().MigrateAsync("20261106194206_ViewerDownloads");
    await InsertRows(db, false);
    await db.Database.MigrateAsync();
    await Dump(db, "UPGRADE_PRE_DL_WITH_DUPLICATES");
}

#if !LEGACY
// Rows from immediately before DeviceIdentity: the older mixed-case row owns
// d:phone, while historical duplicates have no key and remain real records.
var late = Path.Combine(root, "tools/dl-verify/round4-pre-identity.db");
File.Delete(late);
await using (var db = new StreamarrDbContext(new DbContextOptionsBuilder<StreamarrDbContext>().UseSqlite($"Data Source={late}").Options))
{
    await db.GetService<IMigrator>().MigrateAsync("20261106231635_ViewerDownloadsLifecycle");
    await InsertViewer(db);
    await InsertRows(db, false);
    await db.Database.ExecuteSqlRawAsync("UPDATE ViewerDownloads SET DeviceKey='d:phone' WHERE Id='dup-old'");
    await db.Database.MigrateAsync();
    await Dump(db, "UPGRADE_MIXED_CASE_DUPLICATES_FROM_LIFECYCLE");
    var winner = await db.ViewerDownloads.SingleAsync(d => d.ViewerId == "v1" && d.DeviceKey == "d:phone" && d.ClientRef == "ref");
    var duplicates = await db.ViewerDownloads.Where(d => d.DeviceId == "phone" && d.ClientRef == "ref").Select(d => new { d.Id, d.DeviceKey }).ToListAsync();
    bool uniqueRejected = false;
    try { await db.Database.ExecuteSqlRawAsync("UPDATE ViewerDownloads SET DeviceKey='d:phone' WHERE Id='dup-new'"); }
    catch (SqliteException e) when (e.SqliteErrorCode == 19) { uniqueRejected = true; }
    Console.WriteLine("IDENTITY_WINNER " + JsonSerializer.Serialize(new { winner = winner.Id, duplicates, uniqueRejected }));
}
#endif

static Task<int> InsertViewer(StreamarrDbContext db) => db.Database.ExecuteSqlRawAsync("""
    INSERT INTO Viewers (Id,Username,NormalizedUsername,DisplayName,PasswordHash,PasswordSalt,MustChangePassword,IsDisabled,BlockUnrated,AllowTranscoding,FailedLoginCount,CreatedAt,UpdatedAt)
    VALUES ('v1','legacy','LEGACY','Legacy','h','s',0,0,0,1,0,0,0)
    """);

static async Task InsertRows(StreamarrDbContext db, bool oldKey)
{
    var rows = new (string Id, string? Device, string? Ref)[] {
        ("pipe-one","alpha|beta","gamma"), ("pipe-two","alpha","beta|gamma"),
        ("dup-old","Phone","ref"), ("dup-mid","phone","ref"), ("dup-new","PHONE","ref"),
        ("unicode-upper","Ä","same"), ("unicode-lower","ä","same"),
        ("session",null,"ref"), ("no-ref","phone",null),
    };
    var n = 0;
    foreach (var (id, device, reference) in rows)
    {
        n++;
        // Old duplicate rows legitimately have a null key; lifecycle migration
        // must derive the separate columns from raw fields and keep all records.
        var oldColumn = oldKey ? ",IdempotencyKey" : "";
        var oldValue = oldKey ? ",NULL" : "";
        await db.Database.ExecuteSqlRawAsync("INSERT INTO ViewerDownloads (Id,ViewerId,SessionId,DeviceId,ClientRef,WorkId,RequestedReleaseId,State,RequestJson,BytesServed,CreatedAt,UpdatedAt" + oldColumn + ") VALUES ({0},'v1','s',{1},{2},'tmdb-movie-1','r','failed','{{}}',0,{3},{3}" + oldValue + ")", id, device!, reference!, n);
    }
}

static async Task Dump(StreamarrDbContext db, string label)
{
    await db.Database.OpenConnectionAsync();
    await using var command = db.Database.GetDbConnection().CreateCommand();
    command.CommandText = "SELECT Id,DeviceKey,ClientRef,Revision,SecurityGeneration,DeviceId FROM ViewerDownloads ORDER BY CreatedAt";
    await using var reader = await command.ExecuteReaderAsync();
    var records = new List<object>();
    while (await reader.ReadAsync())
        records.Add(new { id = reader.GetString(0), key = reader.IsDBNull(1) ? null : reader.GetString(1), clientRef = reader.IsDBNull(2) ? null : reader.GetString(2), revision = reader.GetInt64(3), generation = reader.GetInt64(4), deviceId = reader.IsDBNull(5) ? null : reader.GetString(5) });
    Console.WriteLine(label + " " + JsonSerializer.Serialize(new { viewer = await db.Viewers.Select(x => new { x.AllowDownloads, x.MaxConcurrentDownloads }).SingleAsync(), records }));
}
