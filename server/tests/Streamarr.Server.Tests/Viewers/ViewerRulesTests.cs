using Streamarr.Server.Persistence.Entities;
using Streamarr.Server.Viewers;
using Streamarr.Server.Viewers.Access;
using Streamarr.Server.Viewers.Auth;
using Streamarr.Server.Viewers.Watch;

namespace Streamarr.Server.Tests.Viewers;

public sealed class ViewerRulesTests
{
    private static readonly DateTimeOffset Now = new(2026, 9, 28, 12, 0, 0, TimeSpan.Zero);
    private static readonly ViewerSettings Settings = new();
    private static readonly WorkKey Movie = WorkKey.TryParse("tmdb-movie-603")!;
    private static readonly long Hour = TimeSpan.FromHours(1).Ticks;

    private static ViewerWatchStateEntity State() => new() { ViewerId = "v", WorkId = Movie.WorkId, Kind = "movie" };

    private static WatchReport Report(string kind, long position, long? duration = null, string? playback = null)
        => new() { Event = kind, Work = Movie, PositionTicks = position, DurationTicks = duration, PlaybackId = playback };

    [Fact]
    public void Mid_Progress_Becomes_A_Resume_Point()
    {
        var state = State();
        WatchProgressRules.Apply(state, Report("progress", Hour / 2, Hour), Settings, Now);
        Assert.Equal(Hour / 2, state.PositionTicks);
        Assert.False(state.Played);
        Assert.Equal(Now, state.LastPlayedAt);
    }

    [Fact]
    public void Below_Min_Resume_Percent_Keeps_No_Resume_Point()
    {
        var state = State();
        WatchProgressRules.Apply(state, Report("stop", Hour * 4 / 100, Hour), Settings, Now);
        Assert.Equal(0, state.PositionTicks);
        Assert.False(state.Played);
    }

    [Fact]
    public void Short_Items_Never_Get_A_Resume_Point()
    {
        var state = State();
        var fourMinutes = TimeSpan.FromMinutes(4).Ticks;
        WatchProgressRules.Apply(state, Report("progress", fourMinutes / 2, fourMinutes), Settings, Now);
        Assert.Equal(0, state.PositionTicks);
    }

    [Fact]
    public void Played_Threshold_Marks_Played_And_Counts_Once_Per_Playback()
    {
        var state = State();
        WatchProgressRules.Apply(state, Report("progress", Hour * 91 / 100, Hour, "p1"), Settings, Now);
        WatchProgressRules.Apply(state, Report("progress", Hour * 95 / 100, Hour, "p1"), Settings, Now);
        WatchProgressRules.Apply(state, Report("stop", Hour * 99 / 100, Hour, "p1"), Settings, Now);
        Assert.True(state.Played);
        Assert.Equal(0, state.PositionTicks);
        Assert.Equal(1, state.PlayCount);

        WatchProgressRules.Apply(state, Report("progress", Hour / 2, Hour, "p2"), Settings, Now);
        Assert.True(state.Played);
        Assert.Equal(Hour / 2, state.PositionTicks);
        WatchProgressRules.Apply(state, Report("stop", Hour * 97 / 100, Hour, "p2"), Settings, Now);
        Assert.Equal(2, state.PlayCount);
    }

    [Fact]
    public void Late_Reports_Of_The_Completing_Playback_Keep_No_Resume_Point()
    {
        var state = State();
        WatchProgressRules.Apply(state, Report("progress", Hour * 92 / 100, Hour, "p1"), Settings, Now);
        WatchProgressRules.Apply(state, Report("progress", Hour * 88 / 100, Hour, "p1"), Settings, Now);
        WatchProgressRules.Apply(state, Report("stop", Hour * 60 / 100, Hour, "p1"), Settings, Now);
        Assert.True(state.Played);
        Assert.Equal(0, state.PositionTicks);
        Assert.Equal(1, state.PlayCount);
    }

    [Fact]
    public void Completion_Without_Playback_Id_Counts_Only_Transitions()
    {
        var state = State();
        WatchProgressRules.Apply(state, Report("progress", Hour * 95 / 100, Hour), Settings, Now);
        WatchProgressRules.Apply(state, Report("progress", Hour * 96 / 100, Hour), Settings, Now);
        Assert.Equal(1, state.PlayCount);
    }

    [Fact]
    public void Start_At_Zero_Keeps_The_Resume_Point()
    {
        var state = State();
        WatchProgressRules.Apply(state, Report("progress", Hour / 3, Hour), Settings, Now);
        WatchProgressRules.Apply(state, Report("start", 0, Hour, "p9"), Settings, Now);
        Assert.Equal(Hour / 3, state.PositionTicks);
        Assert.Equal("p9", state.LastPlaybackId);
    }

    [Fact]
    public void Unknown_Duration_Stores_The_Raw_Position()
    {
        var state = State();
        WatchProgressRules.Apply(state, Report("progress", Hour), Settings, Now);
        Assert.Equal(Hour, state.PositionTicks);
        Assert.False(state.Played);
    }

    [Theory]
    [InlineData("G", 0)]
    [InlineData("PG", 10)]
    [InlineData("PG-13", 13)]
    [InlineData("R", 17)]
    [InlineData("NC-17", 18)]
    [InlineData("TV-Y7", 7)]
    [InlineData("TV-14", 14)]
    [InlineData("TV-MA", 17)]
    [InlineData("0", 0)]
    [InlineData("6", 6)]
    [InlineData("12", 12)]
    [InlineData("FSK 16", 16)]
    [InlineData("FSK-18", 18)]
    [InlineData("12A", 12)]
    [InlineData("15", 15)]
    [InlineData("MA15+", 15)]
    [InlineData("R18+", 18)]
    [InlineData("U", 0)]
    [InlineData("NR", null)]
    [InlineData("Unrated", null)]
    [InlineData("", null)]
    [InlineData(null, null)]
    [InlineData("99", null)]
    [InlineData("banana", null)]
    public void Ratings_Map_To_Minimum_Ages(string? rating, int? expected)
        => Assert.Equal(expected, ContentRatings.MinimumAge(rating));

    [Theory]
    [InlineData(null, false, "PG-13", false, true, "unrestricted")]
    [InlineData(12, false, "PG-13", false, false, "above_age_limit")]
    [InlineData(16, false, "PG-13", false, true, "within_age_limit")]
    [InlineData(12, false, null, false, true, "unrated_allowed")]
    [InlineData(12, true, null, false, false, "unrated_blocked")]
    [InlineData(12, false, null, true, false, "rating_unavailable")]
    [InlineData(null, true, null, true, true, "unrestricted")]
    public void Age_Gate_Decisions(int? maxAge, bool blockUnrated, string? rating, bool lookupFailed, bool allowed, string reason)
    {
        var viewer = new ViewerEntity { Id = "v", MaxAge = maxAge, BlockUnrated = blockUnrated };
        var decision = ViewerContentPolicy.Decide(viewer, "tmdb-movie-1", rating, ContentRatings.MinimumAge(rating), lookupFailed);
        Assert.Equal(allowed, decision.Allowed);
        Assert.Equal(reason, decision.Reason);
    }

    [Theory]
    [InlineData("tmdb-movie-603", "tmdb-movie-603", WorkKind.Movie)]
    [InlineData("tmdb-tv-1396-s1e5", "tmdb-tv-1396-s01e05", WorkKind.Episode)]
    [InlineData("tmdb-tv-1396-s02", "tmdb-tv-1396-s02", WorkKind.Season)]
    [InlineData("tmdb-tv-1396", "tmdb-tv-1396", WorkKind.Series)]
    [InlineData("unmatched-movie-some-title-2020", "unmatched-movie-some-title-2020", WorkKind.Other)]
    public void Work_Ids_Are_Canonicalized(string input, string expected, WorkKind kind)
    {
        var key = WorkKey.TryParse(input);
        Assert.NotNull(key);
        Assert.Equal(expected, key.WorkId);
        Assert.Equal(kind, key.Kind);
    }

    [Theory]
    [InlineData("")]
    [InlineData("tmdb-movie-0")]
    [InlineData("tmdb-tv-abc")]
    [InlineData("movie-603")]
    [InlineData("unmatched-movie-UPPER")]
    [InlineData("tmdb-movie-603; DROP TABLE")]
    public void Invalid_Work_Ids_Are_Rejected(string input) => Assert.Null(WorkKey.TryParse(input));

    [Fact]
    public void Episode_Keys_Know_Their_Series()
    {
        var key = WorkKey.TryParse("tmdb-tv-1396-s03e07")!;
        Assert.Equal("tmdb-tv-1396", key.SeriesWorkId);
        Assert.Equal(3, key.Season);
        Assert.Equal(7, key.Episode);
        Assert.True(key.IsPlayable);
        Assert.False(WorkKey.TryParse("tmdb-tv-1396-s03")!.IsPlayable);
    }

    [Fact]
    public void Totp_Verifies_Current_Code_And_Reports_Its_Step()
    {
        var secret = ViewerTotp.NewSecret();
        var code = ViewerApi.Totp(secret, Now);
        var step = ViewerTotp.Verify(secret, code, Now);
        Assert.NotNull(step);
        Assert.Equal(step, ViewerTotp.Verify(secret, code, Now.AddSeconds(25)));
        Assert.Null(ViewerTotp.Verify(secret, code, Now.AddMinutes(5)));
        Assert.Null(ViewerTotp.Verify(secret, "12345", Now));
        Assert.Contains("otpauth://totp/", ViewerTotp.ProvisioningUri(secret, "Streamarr", "alice"));
    }

    [Fact]
    public void Recovery_Codes_Are_Unique_And_Hash_Case_Insensitively()
    {
        var codes = ViewerTotp.NewRecoveryCodes();
        Assert.Equal(ViewerTotp.RecoveryCodeCount, codes.Distinct().Count());
        Assert.Equal(ViewerTotp.HashRecoveryCode(codes[0]), ViewerTotp.HashRecoveryCode(codes[0].ToUpperInvariant().Replace("-", " ")));
    }

    [Theory]
    [InlineData("ABCD-EFGH", "ABCDEFGH")]
    [InlineData("abcd efgh", "ABCDEFGH")]
    [InlineData("ABCD-EFG", null)]
    [InlineData("ABCD-EFG0", null)]
    [InlineData("ABCD-EFGI", null)]
    public void Emailed_Codes_Normalize_Input(string input, string? expected)
        => Assert.Equal(expected, ViewerCodeService.Normalize(input));

    [Fact]
    public void Password_Rules_And_Generator()
    {
        Assert.NotNull(ViewerPasswords.Problem("short", "alice", Settings));
        Assert.NotNull(ViewerPasswords.Problem("alice123", "Alice123", Settings));
        Assert.NotNull(ViewerPasswords.Problem("aaaaaaaaaa", "alice", Settings));
        Assert.Null(ViewerPasswords.Problem("correct horse", "alice", Settings));
        Assert.True(ViewerPasswords.Generate().Length >= 14);
        Assert.True(ViewerPasswords.Generate(30).Length >= 30);
        Assert.True(ViewerPasswords.IsValidUsername("anna.k"));
        Assert.False(ViewerPasswords.IsValidUsername("-anna"));
        Assert.False(ViewerPasswords.IsValidUsername("an"));
    }

    [Fact]
    public void Settings_Validation_Rejects_Out_Of_Range_Values()
    {
        Assert.Empty(new ViewerSettings().Validate());
        Assert.NotEmpty((new ViewerSettings() with { PlayedPercent = 40 }).Validate());
        Assert.NotEmpty((new ViewerSettings() with { Email = new ViewerEmailSettings { Mode = ViewerEmailMode.Smtp } }).Validate());
        Assert.NotEmpty((new ViewerSettings() with { Email = new ViewerEmailSettings { FromAddress = "not-an-address" } }).Validate());
    }
}
