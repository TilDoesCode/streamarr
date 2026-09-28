using System.Net;
using System.Threading.Channels;
using MailKit.Net.Smtp;
using MailKit.Security;
using MimeKit;

namespace Streamarr.Server.Viewers.Email;

public sealed record ViewerMailMessage(string To, string Subject, string Text, string Html, string Kind);

public sealed record CapturedMail(string Id, DateTimeOffset CreatedAt, ViewerMailMessage Message);

/// <summary>In-memory capture of the most recent messages when email delivery runs in test-outbox mode.</summary>
public sealed class ViewerMailOutbox(TimeProvider time)
{
    public const int Capacity = 50;
    private readonly LinkedList<CapturedMail> _items = new();
    private readonly object _lock = new();

    public void Add(ViewerMailMessage message)
    {
        lock (_lock)
        {
            _items.AddFirst(new CapturedMail(Guid.NewGuid().ToString("n"), time.GetUtcNow(), message));
            while (_items.Count > Capacity)
                _items.RemoveLast();
        }
    }

    public IReadOnlyList<CapturedMail> List()
    {
        lock (_lock)
            return _items.ToList();
    }

    public void Clear()
    {
        lock (_lock)
            _items.Clear();
    }
}

/// <summary>Delivers viewer emails through SMTP (MailKit) off the request path, or captures them in the test outbox.</summary>
public sealed class ViewerMailer(
    ViewerSettingsService settings,
    ViewerMailOutbox outbox,
    ILogger<ViewerMailer> logger) : BackgroundService
{
    private readonly Channel<ViewerMailMessage> _queue = Channel.CreateBounded<ViewerMailMessage>(
        new BoundedChannelOptions(200) { FullMode = BoundedChannelFullMode.DropWrite, SingleReader = true });

    public static bool CanDeliver(ViewerSettings current)
        => current.Email.Mode switch
        {
            ViewerEmailMode.Outbox => true,
            ViewerEmailMode.Smtp => !string.IsNullOrWhiteSpace(current.Email.SmtpHost) && current.Email.FromAddress.Length > 0,
            _ => false,
        };

    /// <summary>Queues a message without waiting for delivery so responses do not reveal whether an account exists.</summary>
    public void Enqueue(ViewerMailMessage message)
    {
        switch (settings.Current.Email.Mode)
        {
            case ViewerEmailMode.Outbox:
                outbox.Add(message);
                break;
            case ViewerEmailMode.Smtp:
                if (!_queue.Writer.TryWrite(message))
                    logger.LogWarning("Viewer mail queue is full; dropped a {Kind} message", message.Kind);
                break;
            default:
                logger.LogDebug("Viewer email delivery is disabled; dropped a {Kind} message", message.Kind);
                break;
        }
    }

    /// <summary>Delivers synchronously and surfaces transport errors (used by the admin test action).</summary>
    public async Task SendNowAsync(ViewerMailMessage message, CancellationToken ct)
    {
        var current = await settings.GetAsync(ct);
        switch (current.Email.Mode)
        {
            case ViewerEmailMode.Outbox:
                outbox.Add(message);
                return;
            case ViewerEmailMode.Smtp:
                await SendSmtpAsync(current.Email, await settings.GetSmtpPasswordAsync(ct), message, ct);
                return;
            default:
                throw ViewerProblem.Conflict("email_unavailable", "Email delivery is disabled in the viewer settings.");
        }
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        await foreach (var message in _queue.Reader.ReadAllAsync(stoppingToken))
        {
            for (var attempt = 1; attempt <= 2; attempt++)
            {
                try
                {
                    var current = await settings.GetAsync(stoppingToken);
                    if (current.Email.Mode != ViewerEmailMode.Smtp)
                        break;
                    await SendSmtpAsync(current.Email, await settings.GetSmtpPasswordAsync(stoppingToken), message, stoppingToken);
                    break;
                }
                catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
                {
                    return;
                }
                catch (Exception e)
                {
                    logger.LogWarning(e, "Viewer {Kind} email delivery failed (attempt {Attempt})", message.Kind, attempt);
                    if (attempt == 1)
                        await Task.Delay(TimeSpan.FromSeconds(5), stoppingToken);
                }
            }
        }
    }

    private static async Task SendSmtpAsync(ViewerEmailSettings email, string password, ViewerMailMessage message, CancellationToken ct)
    {
        var mime = new MimeMessage();
        mime.From.Add(new MailboxAddress(email.FromName, email.FromAddress));
        mime.To.Add(MailboxAddress.Parse(message.To));
        mime.Subject = message.Subject;
        mime.Body = new BodyBuilder { TextBody = message.Text, HtmlBody = message.Html }.ToMessageBody();

        using var client = new SmtpClient { Timeout = 20_000 };
        var security = email.SmtpSecurity switch
        {
            SmtpSecurity.None => SecureSocketOptions.None,
            SmtpSecurity.StartTls => SecureSocketOptions.StartTls,
            SmtpSecurity.SslOnConnect => SecureSocketOptions.SslOnConnect,
            _ => SecureSocketOptions.Auto,
        };
        await client.ConnectAsync(email.SmtpHost, email.SmtpPort, security, ct);
        if (!string.IsNullOrEmpty(email.SmtpUsername))
            await client.AuthenticateAsync(email.SmtpUsername, password, ct);
        await client.SendAsync(mime, ct);
        await client.DisconnectAsync(quit: true, ct);
    }
}

/// <summary>Plain-text and minimal HTML bodies for every viewer email.</summary>
public static class ViewerMailTemplates
{
    public static ViewerMailMessage LoginCode(string server, string to, string name, string code, int minutes)
        => Build(to, $"{server} sign-in code: {code}", "login_code", name,
            $"Use this code to sign in to {server}:", code,
            $"The code expires in {minutes} minutes. If you did not try to sign in, you can ignore this email.");

    public static ViewerMailMessage PasswordReset(string server, string to, string name, string code, int minutes)
        => Build(to, $"Reset your {server} password", "password_reset", name,
            $"Use this code to choose a new {server} password:", code,
            $"The code expires in {minutes} minutes. If you did not ask for a reset, your password stays unchanged.");

    public static ViewerMailMessage VerifyEmail(string server, string to, string name, string code, int minutes)
        => Build(to, $"Confirm your email for {server}", "email_verification", name,
            $"Use this code to confirm this address for your {server} viewer account:", code,
            $"The code expires in {minutes} minutes.");

    public static ViewerMailMessage Test(string server, string to)
        => Build(to, $"{server} test email", "test", "there",
            $"Email delivery for {server} viewer accounts works.", "OK", "No action is needed.");

    private static ViewerMailMessage Build(string to, string subject, string kind, string name, string lead, string code, string footer)
    {
        var text = $"Hi {name},\n\n{lead}\n\n    {code}\n\n{footer}\n";
        var html = $"""
            <div style="font-family:system-ui,sans-serif;font-size:15px;line-height:1.5;color:#111">
            <p>Hi {WebUtility.HtmlEncode(name)},</p>
            <p>{WebUtility.HtmlEncode(lead)}</p>
            <p style="font-size:26px;font-weight:700;letter-spacing:.12em;font-family:ui-monospace,monospace">{WebUtility.HtmlEncode(code)}</p>
            <p style="color:#555">{WebUtility.HtmlEncode(footer)}</p>
            </div>
            """;
        return new ViewerMailMessage(to, subject, text, html, kind);
    }
}
