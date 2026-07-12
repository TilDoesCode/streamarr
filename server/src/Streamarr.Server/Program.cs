var builder = WebApplication.CreateBuilder(args);

// appsettings.Local.json is git-ignored and carries real credentials when the
// owner supplies them (DECISIONS.md open items). It always overrides.
builder.Configuration.AddJsonFile("appsettings.Local.json", optional: true, reloadOnChange: true);

builder.Services.AddControllers();

// OpenAPI is the cross-interface contract (BRIEF.md §3.1); Swashbuckle serves it.
builder.Services.AddEndpointsApiExplorer();
builder.Services.AddSwaggerGen();

var app = builder.Build();

if (app.Environment.IsDevelopment())
{
    app.UseSwagger();
    app.UseSwaggerUI();
}

app.MapControllers();

app.Run();

// Exposed for WebApplicationFactory-based integration tests.
public partial class Program;
