namespace Streamarr.Server.Contracts;

/// <summary>Body of POST /api/v1/auth/login (BRIEF §6.4).</summary>
public sealed record LoginRequest
{
    public string? Username { get; init; }
    public string? Password { get; init; }
}

/// <summary>A minted admin session token and its lifetime.</summary>
public sealed record LoginResponse
{
    public required string Token { get; init; }
    public string TokenType { get; init; } = "Bearer";
    public required int ExpiresInSeconds { get; init; }
    public required DateTimeOffset ExpiresAt { get; init; }
    public required string Username { get; init; }
    public required string Role { get; init; }
}

/// <summary>Identity of the caller behind the current bearer token (GET /api/v1/auth/me).</summary>
public sealed record MeResponse
{
    public required string Name { get; init; }
    public required string Role { get; init; }
}

/// <summary>Body of POST /api/v1/auth/password — admin self-service password change.</summary>
public sealed record ChangePasswordRequest
{
    public string? CurrentPassword { get; init; }
    public string? NewPassword { get; init; }
}
