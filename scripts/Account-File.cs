using System;
using System.IO;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Security.Cryptography;
using System.Text;
using Microsoft.Win32.SafeHandles;

// Fixed local helper only. No credential discovery, process control, paths from HTTP, or logging.
public static class CodexAccountFile {
    [StructLayout(LayoutKind.Sequential)] struct Info {
        public uint Attr, CreationLow, CreationHigh, AccessLow, AccessHigh, WriteLow, WriteHigh;
        public uint Volume, SizeHigh, SizeLow, Links, IndexHigh, IndexLow;
    }
    [StructLayout(LayoutKind.Sequential)] struct SecurityAttributes { public int Length; public IntPtr Descriptor; public int Inherit; }
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    static extern SafeFileHandle CreateFileW(string name, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    static extern SafeFileHandle CreateFileW(string name, uint access, uint share, ref SecurityAttributes security, uint creation, uint flags, IntPtr template);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetFileInformationByHandle(SafeFileHandle file, out Info info);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetFileInformationByHandle(SafeFileHandle file, int kind, IntPtr data, uint size);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern uint GetFinalPathNameByHandleW(SafeFileHandle file, StringBuilder path, uint size, uint flags);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool FlushFileBuffers(SafeFileHandle file);
    [DllImport("advapi32.dll", SetLastError=true)] static extern uint GetSecurityInfo(SafeFileHandle handle, int type, uint info, out IntPtr owner, out IntPtr group, out IntPtr dacl, out IntPtr sacl, out IntPtr descriptor);
    [DllImport("advapi32.dll")] static extern uint GetSecurityDescriptorLength(IntPtr descriptor);
    [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr memory);
    [StructLayout(LayoutKind.Sequential)] struct IoStatus { public IntPtr Status, Information; }
    [DllImport("ntdll.dll")] static extern int NtSetInformationFile(SafeFileHandle file, out IoStatus status, IntPtr data, uint size, int kind);
    static void Fail(string code) { throw new IOException(code); }
    static Info Inspect(SafeFileHandle h, bool directory = false) {
        Info i = default;
        if (h.IsInvalid || !GetFileInformationByHandle(h, out i) || (i.Attr & 0x400) != 0 || ((i.Attr & 0x10) != 0) != directory || (!directory && i.Links != 1)) Fail("ACCOUNT_STORAGE_UNSAFE");
        return i;
    }
    public static string Identity(SafeFileHandle h) {
        var i = Inspect(h);
        return i.Volume.ToString("x8") + ":" + i.IndexHigh.ToString("x8") + i.IndexLow.ToString("x8") + ":" + i.CreationHigh.ToString("x8") + i.CreationLow.ToString("x8");
    }
    static void PathMatches(SafeFileHandle h, string path) {
        var name = new StringBuilder(32768);
        uint n = GetFinalPathNameByHandleW(h, name, 32768, 0);
        if (n == 0 || n >= 32768 || !String.Equals(name.ToString(), "\\\\?\\" + path, StringComparison.OrdinalIgnoreCase)) Fail("ACCOUNT_STORAGE_UNSAFE");
    }
    static void Acl(SafeFileHandle h, bool privateFile) {
        IntPtr owner, group, dacl, sacl, descriptor;
        if (GetSecurityInfo(h, 1, 5, out owner, out group, out dacl, out sacl, out descriptor) != 0) Fail("ACCOUNT_STORAGE_UNSAFE");
        try {
            byte[] bytes = new byte[GetSecurityDescriptorLength(descriptor)]; Marshal.Copy(descriptor, bytes, 0, bytes.Length);
            var sd = new RawSecurityDescriptor(bytes, 0); var sid = WindowsIdentity.GetCurrent().User;
            if (sd.Owner != sid || sd.DiscretionaryAcl == null || (privateFile && ((sd.ControlFlags & ControlFlags.DiscretionaryAclProtected) == 0 || sd.DiscretionaryAcl.Count != 1))) Fail("ACCOUNT_STORAGE_UNSAFE");
            bool own = false; int full = (int)FileSystemRights.FullControl, read = (int)(FileSystemRights.ReadAndExecute | FileSystemRights.Synchronize);
            foreach (GenericAce raw in sd.DiscretionaryAcl) {
                var ace = raw as CommonAce;
                if (ace == null || ace.AceQualifier != AceQualifier.AccessAllowed || (ace.AceFlags & AceFlags.InheritOnly) != 0) Fail("ACCOUNT_STORAGE_UNSAFE");
                if (ace.SecurityIdentifier == sid && (ace.AccessMask & full) == full) own = true;
                else if (privateFile || ((ace.SecurityIdentifier.Value != "S-1-5-18" && ace.SecurityIdentifier.Value != "S-1-5-32-544") && (ace.AccessMask & ~read) != 0)) Fail("ACCOUNT_STORAGE_UNSAFE");
            }
            if (!own) Fail("ACCOUNT_STORAGE_UNSAFE");
        } finally { LocalFree(descriptor); }
    }
    static List<SafeFileHandle> Parents(string path) {
        if (!Path.IsPathFullyQualified(path) || path.StartsWith("\\\\") || Path.GetFullPath(path) != path) Fail("ACCOUNT_STORAGE_UNSAFE");
        var handles = new List<SafeFileHandle>();
        try {
            string current = Path.GetPathRoot(path), relative = path.Substring(current.Length);
            var parts = relative.Split(Path.DirectorySeparatorChar);
            for (int n = 0; n < parts.Length; n++) {
                if (String.IsNullOrEmpty(parts[n]) || parts[n].IndexOfAny("<>:\"|?*\r\n".ToCharArray()) >= 0 || parts[n].EndsWith(".") || parts[n].EndsWith(" ")) Fail("ACCOUNT_STORAGE_UNSAFE");
                current = Path.Combine(current, parts[n]);
                if (n == parts.Length - 1) break;
                var h = CreateFileW(current, 0x20080, 3, IntPtr.Zero, 3, 0x02200000, IntPtr.Zero); handles.Add(h);
                Inspect(h, true); PathMatches(h, current);
            }
            return handles;
        } catch { foreach (var h in handles) h.Dispose(); throw; }
    }
    static SafeFileHandle Open(string path, uint access, uint share) {
        var h = CreateFileW(path, access, share, IntPtr.Zero, 3, 0x00200000, IntPtr.Zero);
        if (h.IsInvalid) { h.Dispose(); Fail("ACCOUNT_CACHE_BUSY"); }
        try { Inspect(h); PathMatches(h, path); Acl(h, false); return h; } catch { h.Dispose(); throw; }
    }
    public static void CheckFile(string path) { using (var h = CreateFileW(path, 0x80000000, 1, IntPtr.Zero, 3, 0x00200000, IntPtr.Zero)) Inspect(h); }
    public static void ReplaceStore(string staged, string destination) { File.Replace(staged, destination, null); }
    public static string Hash(byte[] bytes) { return Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant(); }
    static byte[] Read(SafeFileHandle h) {
        long length = RandomAccess.GetLength(h);
        if (length < 10 || length > 32768) Fail("ACCOUNT_CACHE_UNSUPPORTED");
        byte[] bytes = new byte[length]; int at = 0;
        while (at < bytes.Length) { int n = RandomAccess.Read(h, bytes.AsSpan(at), at); if (n == 0) Fail("ACCOUNT_CACHE_CHANGED"); at += n; }
        return bytes;
    }
    public sealed class Cache { public byte[] Bytes; public string FileId; }
    public static Cache ReadCache(string path) {
        var parents = Parents(path);
        try { using (var h = Open(path, 0x80020000, 1)) return new Cache { Bytes = Read(h), FileId = Identity(h) }; }
        finally { foreach (var h in parents) h.Dispose(); }
    }
    static void Rename(SafeFileHandle h, string destination) {
        byte[] name = Encoding.Unicode.GetBytes(destination + "\0"); int root = IntPtr.Size == 8 ? 8 : 4, length = root + IntPtr.Size, start = length + 4;
        IntPtr data = Marshal.AllocHGlobal(start + name.Length);
        try {
            for (int i = 0; i < start; i++) Marshal.WriteByte(data, i, 0);
            Marshal.WriteInt32(data, length, name.Length - 2); Marshal.Copy(name, 0, IntPtr.Add(data, start), name.Length);
            if (!SetFileInformationByHandle(h, 3, data, (uint)(start + name.Length))) Fail("ACCOUNT_CACHE_CHANGED");
        } finally { Marshal.FreeHGlobal(data); }
    }
    static void DeleteOnClose(SafeFileHandle h, bool delete) {
        // Retire only the already locked, owner/hash/identity-checked source. Durable recovery precedes this.
        IntPtr data = Marshal.AllocHGlobal(4);
        try { Marshal.WriteInt32(data, delete ? 1 : 0); if (!SetFileInformationByHandle(h, 4, data, 4)) Fail("ACCOUNT_STORAGE_UNSUPPORTED"); }
        finally { Marshal.FreeHGlobal(data); }
    }
    static SafeFileHandle Stage(string path, byte[] bytes) {
        var sid = WindowsIdentity.GetCurrent().User;
        var sd = new RawSecurityDescriptor("O:" + sid.Value + "D:P(A;;FA;;;" + sid.Value + ")"); byte[] binary = new byte[sd.BinaryLength]; sd.GetBinaryForm(binary, 0);
        IntPtr descriptor = Marshal.AllocHGlobal(binary.Length); SafeFileHandle h = null;
        try {
            Marshal.Copy(binary, 0, descriptor, binary.Length); var sa = new SecurityAttributes { Length = Marshal.SizeOf<SecurityAttributes>(), Descriptor = descriptor };
            h = CreateFileW(path, 0xc0030000, 0, ref sa, 1, 0x04200000, IntPtr.Zero);
            if (h.IsInvalid) Fail("ACCOUNT_RECOVERY_REQUIRED");
            Inspect(h); Acl(h, true); RandomAccess.Write(h, bytes, 0);
            if (!FlushFileBuffers(h)) Fail("ACCOUNT_STORAGE_UNSAFE"); return h;
        } catch { h?.Dispose(); throw; } finally { Marshal.FreeHGlobal(descriptor); }
    }
    // The broker must durably encrypt previous + target + transaction before calling this.
    // checkpoint is only used by the synthetic direct C# fixture, never by the production JSON protocol.
    public static string Publish(string path, string expected, string sourceId, byte[] bytes, string transaction, Action<string> checkpoint = null) {
        if (String.IsNullOrEmpty(expected)) { if (!String.IsNullOrEmpty(sourceId)) Fail("ACCOUNT_STORAGE_UNSAFE"); expected = null; }
        if (Path.GetFileName(path) != "auth.json" || !Guid.TryParseExact(transaction, "D", out _) || bytes.Length < 10 || bytes.Length > 32768 || (expected != null && (expected.Length != 64 || String.IsNullOrEmpty(sourceId)))) Fail("ACCOUNT_STORAGE_UNSAFE");
        var parents = Parents(path); SafeFileHandle source = null, stage = null;
        string staged = Path.Combine(Path.GetDirectoryName(path), ".codex-phone-" + transaction + ".new"), held = Path.Combine(Path.GetDirectoryName(path), ".codex-phone-" + transaction + ".old");
        try {
            if (File.Exists(held) || Directory.Exists(held)) Fail("ACCOUNT_RECOVERY_REQUIRED");
            if (expected != null) {
                source = Open(path, 0x80030000, 1); byte[] previous = Read(source);
                try { if (Identity(source) != sourceId || Hash(previous) != expected) Fail("ACCOUNT_CACHE_CHANGED"); } finally { Array.Clear(previous); }
            }
            stage = Stage(staged, bytes); checkpoint?.Invoke("staged");
            if (source != null) {
                DeleteOnClose(source, true); source.Dispose(); source = null; checkpoint?.Invoke("held");
            }
            Rename(stage, path); checkpoint?.Invoke("published");
            IntPtr clear = Marshal.AllocHGlobal(4);
            try { Marshal.WriteInt32(clear, 8); IoStatus status; if (NtSetInformationFile(stage, out status, clear, 4, 64) < 0) Fail("ACCOUNT_STORAGE_UNSUPPORTED"); }
            finally { Marshal.FreeHGlobal(clear); }
            string installed = Identity(stage); stage.Dispose(); stage = null; return installed;
        } finally {
            source?.Dispose(); stage?.Dispose(); foreach (var h in parents) h.Dispose();
        }
    }
}
