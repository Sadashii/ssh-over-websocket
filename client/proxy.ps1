$ProgressPreference='SilentlyContinue'
# ProxyCommand helper for Windows PowerShell 5.1+: raw SSH over a fake WebSocket upgrade via {{HOST}}.
# Uses the real Win32 stdin/stdout handles with overlapped I/O; the usual Console/CopyToAsync routes lose data.
Add-Type -TypeDefinition @"
using System; using System.IO; using System.Net.Sockets; using System.Text; using System.Threading; using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class SxProxy {
  [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int n);
  static Stream Std(int id, FileAccess fa) {
    var h = new SafeFileHandle(GetStdHandle(id), false);
    try { return new FileStream(h, fa, 16384, true); } catch { return new FileStream(h, fa, 16384, false); }
  }
  public static void Run(string host, int port) {
    var c = new TcpClient(host, port); c.NoDelay = true;
    var s = c.GetStream();
    var q = Encoding.ASCII.GetBytes("GET / HTTP/1.1\r\nHost: " + host + "\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n");
    s.Write(q, 0, q.Length);
    var i = Std(-10, FileAccess.Read); var o = Std(-11, FileAccess.Write);
    var t = new Thread(delegate() {
      var b = new byte[16384]; int n;
      try { while ((n = i.Read(b, 0, b.Length)) > 0) { s.Write(b, 0, n); } } catch (Exception e) { Console.Error.WriteLine("stdin err: " + e.Message); }
      Environment.Exit(0);
    });
    t.IsBackground = true; t.Start();
    var b2 = new byte[16384]; int m;
    try { while ((m = s.Read(b2, 0, b2.Length)) > 0) { o.Write(b2, 0, m); o.Flush(); } } catch (Exception e) { Console.Error.WriteLine("net err: " + e.Message); }
    Environment.Exit(0);
  }
}
"@
# Port 80 is used on purpose (a plain HTTP upgrade to the proxy); the SSH session inside stays end-to-end encrypted.
[SxProxy]::Run('{{HOST}}', 80)
