using System;
using System.IO;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using Microsoft.Win32.SafeHandles;

// Build/control-file leases only. No path from HTTP, credential discovery or process control.
public sealed class PocketPrivateFile : IDisposable {
    [StructLayout(LayoutKind.Sequential)] struct Info {
        public uint Attr, CreationLow, CreationHigh, AccessLow, AccessHigh, WriteLow, WriteHigh;
        public uint Volume, SizeHigh, SizeLow, Links, IndexHigh, IndexLow;
    }
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    static extern SafeFileHandle CreateFileW(string path, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetFileInformationByHandle(SafeFileHandle file, out Info info);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern uint GetFinalPathNameByHandleW(SafeFileHandle file, StringBuilder path, uint size, uint flags);
    [DllImport("advapi32.dll", SetLastError=true)] static extern uint GetSecurityInfo(SafeFileHandle file, int type, uint info, out IntPtr owner, out IntPtr group, out IntPtr dacl, out IntPtr sacl, out IntPtr descriptor);
    [DllImport("advapi32.dll")] static extern uint GetSecurityDescriptorLength(IntPtr descriptor);
    [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr memory);
    readonly List<SafeFileHandle> handles = new List<SafeFileHandle>();
    SafeFileHandle leaf;
    static void Fail() { throw new IOException("PRIVATE_FILE_UNSAFE"); }
    static void Inspect(SafeFileHandle file, string path, bool directory) {
        Info info;
        if (file.IsInvalid || !GetFileInformationByHandle(file, out info) || (info.Attr & 0x400) != 0 || ((info.Attr & 0x10) != 0) != directory || (!directory && info.Links != 1)) Fail();
        var name = new StringBuilder(32768);
        uint length = GetFinalPathNameByHandleW(file, name, 32768, 0);
        if (length == 0 || length >= 32768 || !String.Equals(name.ToString(), "\\\\?\\" + path, StringComparison.OrdinalIgnoreCase)) Fail();
    }
    static void PrivateAcl(SafeFileHandle file) {
        IntPtr owner, group, dacl, sacl, descriptor;
        if (GetSecurityInfo(file, 1, 5, out owner, out group, out dacl, out sacl, out descriptor) != 0) Fail();
        try {
            var bytes = new byte[GetSecurityDescriptorLength(descriptor)]; Marshal.Copy(descriptor, bytes, 0, bytes.Length);
            var sd = new RawSecurityDescriptor(bytes, 0); var sid = WindowsIdentity.GetCurrent().User;
            if (sd.Owner != sid || sd.DiscretionaryAcl == null || sd.DiscretionaryAcl.Count != 1) Fail();
            var ace = sd.DiscretionaryAcl[0] as CommonAce; int full = (int)FileSystemRights.FullControl;
            if (ace == null || ace.AceQualifier != AceQualifier.AccessAllowed || ace.SecurityIdentifier != sid || (ace.AceFlags & AceFlags.InheritOnly) != 0 || (ace.AccessMask & full) != full) Fail();
        } finally { LocalFree(descriptor); }
    }
    PocketPrivateFile(string path, long maximum) {
        try {
            if (!Path.IsPathFullyQualified(path) || path.StartsWith("\\\\") || Path.GetFullPath(path) != path || maximum < 1) Fail();
            string current = Path.GetPathRoot(path); var parts = path.Substring(current.Length).Split(Path.DirectorySeparatorChar);
            for (int n = 0; n < parts.Length; n++) {
                string part = parts[n];
                if (String.IsNullOrEmpty(part) || part == "." || part == ".." || part.IndexOfAny("<>:\"|?*\r\n".ToCharArray()) >= 0 || part.EndsWith(".") || part.EndsWith(" ")) Fail();
                current = Path.Combine(current, part); bool directory = n < parts.Length - 1;
                // Deny write/delete sharing on leaf, deny directory rename while tools use it.
                var h = CreateFileW(current, directory ? 0x20080u : 0x80020000u, directory ? 3u : 1u, IntPtr.Zero, 3, directory ? 0x02200000u : 0x00200000u, IntPtr.Zero);
                handles.Add(h); Inspect(h, current, directory);
                if (!directory) { leaf = h; PrivateAcl(h); if (RandomAccess.GetLength(h) < 1 || RandomAccess.GetLength(h) > maximum) Fail(); }
            }
            if (leaf == null) Fail();
        } catch { Dispose(); throw; }
    }
    public static PocketPrivateFile Open(string path, long maximum) { return new PocketPrivateFile(path, maximum); }
    public string ReadUtf8(int maximum) {
        long length = RandomAccess.GetLength(leaf); if (length < 1 || length > maximum) Fail();
        var bytes = new byte[(int)length]; int at = 0;
        while (at < bytes.Length) { int n = RandomAccess.Read(leaf, bytes.AsSpan(at), at); if (n == 0) Fail(); at += n; }
        return new UTF8Encoding(false, true).GetString(bytes);
    }
    public void Dispose() { foreach (var h in handles) h.Dispose(); handles.Clear(); leaf = null; }
}
