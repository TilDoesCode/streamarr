namespace Streamarr.DevWorld.Tests;

public class DevWorldOptionsTests
{
    [Theory]
    [InlineData("0.0.0.0", "http://0.0.0.0:39300", "http://127.0.0.1:39300", "http://10.0.2.2:39300")]
    [InlineData("::", "http://[::]:39300", "http://127.0.0.1:39300", "http://10.0.2.2:39300")]
    [InlineData("127.0.0.1", "http://127.0.0.1:39300", "http://127.0.0.1:39300", "http://10.0.2.2:39300")]
    [InlineData("localhost", "http://localhost:39300", "http://127.0.0.1:39300", "http://10.0.2.2:39300")]
    [InlineData("192.168.1.5", "http://192.168.1.5:39300", "http://192.168.1.5:39300", "http://192.168.1.5:39300")]
    [InlineData("fd00::5", "http://[fd00::5]:39300", "http://[fd00::5]:39300", "http://[fd00::5]:39300")]
    public void Urls_FollowTheBindHost(string host, string bind, string local, string emulator)
    {
        var options = new DevWorldOptions { Host = host, CacheDir = "/c", StateDir = "/s", CatalogPath = "/cat.json" };

        Assert.Equal(bind, options.BindUrl);
        Assert.Equal(local, options.LocalUrl);
        Assert.Equal(emulator, options.AndroidEmulatorUrl);
    }
}
