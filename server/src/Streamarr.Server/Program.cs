using Streamarr.Server;

var builder = WebApplication.CreateBuilder(args);

// appsettings.Local.json is git-ignored and carries real credentials when the
// owner supplies them (DECISIONS.md open items). It always overrides.
builder.Configuration.AddJsonFile("appsettings.Local.json", optional: true, reloadOnChange: true);

builder.AddStreamarrServer();

var app = builder.Build();
app.UseStreamarrServer();

app.Run();

// Exposed for WebApplicationFactory-based integration tests.
public partial class Program;
