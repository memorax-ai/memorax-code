using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Security;
using System.Security.Principal;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using Microsoft.Win32;

public sealed class CursorWindowsSessionException : Exception
{
    public string Code { get; private set; }
    public string CleanupErrorCode { get; internal set; }
    public uint? NativeHResult { get; internal set; }
    internal CursorWindowsSessionException(string suffix) : base("CURSOR_APP_WINDOWS_SESSION_" + suffix)
    { Code = Message; }
}

public sealed class CursorWindowsSessionState
{
    public bool LeaderStarted { get; internal set; }
    public bool LeaderExited { get; internal set; }
    public uint? ExitCode { get; internal set; }
    public uint ActiveProcesses { get; internal set; }
    public bool ProcessesClosed { get; internal set; }
    public bool ProfileCreationAttempted { get; internal set; }
    public bool ProfileCreated { get; internal set; }
    public bool ProfileLoaded { get; internal set; }
    public bool ProfileDeleted { get; internal set; }
    public bool Closed { get; internal set; }
}

// The coordinator owns fresh account creation and removal. This object owns only
// its exact profile, returned process handles, and unnamed, non-breakaway job.
public sealed class CursorWindowsOwnedSession
{
    private readonly string userName, expectedSid;
    private readonly SecureString password;
    private readonly ICursorWindowsSessionNative native;
    private IntPtr token, profile, job, process, thread;
    private bool prepareAttempted, prepared, profileCreationAttempted, profileCreated, profileDeleted;
    private bool launchAttempted, leaderStarted, leaderExited, closing, closed;
    private uint? exitCode;
    public string ProfilePath { get; private set; }

    public CursorWindowsOwnedSession(string userName, string expectedSid, SecureString password)
        : this(userName, expectedSid, password, DefaultNative()) { }

    internal CursorWindowsOwnedSession(string userName, string expectedSid, SecureString password,
        ICursorWindowsSessionNative native)
    {
        try
        {
            Require(userName != null && Regex.IsMatch(userName, @"\A[A-Za-z][A-Za-z0-9_-]{0,19}\z") &&
                expectedSid != null && Regex.IsMatch(expectedSid, @"\AS-1-5-21-\d+-\d+-\d+-\d+\z") &&
                password != null && password.Length > 0 && password.Length <= 256 && native != null, "ARGUMENTS");
            this.userName = userName; this.expectedSid = expectedSid; this.native = native;
            this.password = password.Copy(); this.password.MakeReadOnly();
        }
        catch (Exception error) { throw Fixed(error, "ARGUMENTS"); }
    }

    private static ICursorWindowsSessionNative DefaultNative()
    {
        Require(RuntimeInformation.IsOSPlatform(OSPlatform.Windows), "PLATFORM");
        return new CursorWindowsSessionNative();
    }

    internal static void Require(bool value, string code)
    { if (!value) throw new CursorWindowsSessionException(code); }
    private static CursorWindowsSessionException Fixed(Exception error, string code)
    { return error as CursorWindowsSessionException ?? new CursorWindowsSessionException(code); }
    private void WithPassword(Action<IntPtr> action)
    {
        IntPtr pointer = Marshal.SecureStringToGlobalAllocUnicode(password);
        try { action(pointer); } finally { Marshal.ZeroFreeGlobalAllocUnicode(pointer); }
    }

    public void CreateAndLoadProfile()
    {
        try
        {
            Require(!closed && !prepareAttempted && !closing, "STATE");
            prepareAttempted = true;
            native.CreateJob(ref job);
            WithPassword(pointer => native.Authenticate(userName, expectedSid, pointer, ref token));
            profileCreationAttempted = true;
            ProfilePath = native.CreateProfile(userName, expectedSid);
            profileCreated = true;
            native.LoadProfile(token, userName, ref profile);
            native.VerifyProfile(token, expectedSid, ProfilePath, true);
            prepared = true;
        }
        catch (Exception error) { throw Fixed(error, "PROFILE_PREPARE"); }
    }

    internal static string QuoteArgument(string value)
    {
        Require(value != null && value.IndexOf('\0') < 0 && value.IndexOf('\r') < 0 && value.IndexOf('\n') < 0, "ARGUMENTS");
        StringBuilder result = new StringBuilder("\"");
        int slashes = 0;
        foreach (char ch in value)
        {
            if (ch == '\\') { slashes++; continue; }
            result.Append('\\', ch == '"' ? slashes * 2 + 1 : slashes);
            result.Append(ch); slashes = 0;
        }
        return result.Append('\\', slashes * 2).Append('"').ToString();
    }

    private string EnvironmentBlock(IDictionary environment)
    {
        Require(environment != null && environment.Count > 0 && environment.Count <= 128, "ENVIRONMENT");
        SortedDictionary<string, string> values = new SortedDictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (DictionaryEntry entry in environment)
        {
            string key = entry.Key as string, value = entry.Value as string;
            Require(key != null && Regex.IsMatch(key, @"\A[A-Za-z_][A-Za-z0-9_]*\z") && value != null &&
                value.IndexOf('\0') < 0 && !values.ContainsKey(key), "ENVIRONMENT");
            values.Add(key, value);
        }
        foreach (KeyValuePair<string, string> item in new Dictionary<string, string> {
            { "USERPROFILE", ProfilePath }, { "APPDATA", ProfilePath + @"\AppData\Roaming" },
            { "LOCALAPPDATA", ProfilePath + @"\AppData\Local" } })
        {
            string value;
            Require(values.TryGetValue(item.Key, out value) && String.Equals(value, item.Value, StringComparison.OrdinalIgnoreCase), "ENVIRONMENT");
        }
        Require(!values.ContainsKey("HOME") || String.Equals(values["HOME"], ProfilePath, StringComparison.OrdinalIgnoreCase), "ENVIRONMENT");
        StringBuilder block = new StringBuilder();
        foreach (KeyValuePair<string, string> item in values) block.Append(item.Key).Append('=').Append(item.Value).Append('\0');
        block.Append('\0');
        Require(block.Length <= 32767, "ENVIRONMENT");
        return block.ToString();
    }

    public uint StartBootstrap(string executable, string[] arguments, string workingDirectory, IDictionary environment)
    {
        Require(prepared && profile != IntPtr.Zero && !closed && !closing && !launchAttempted, "STATE");
        try
        {
            launchAttempted = true;
            Require(arguments != null && arguments.Length <= 64, "ARGUMENTS");
            StringBuilder command = new StringBuilder(QuoteArgument(executable));
            foreach (string argument in arguments) command.Append(' ').Append(QuoteArgument(argument));
            Require(command.Length < 1024, "ARGUMENTS");
            string environmentBlock = EnvironmentBlock(environment);
            native.ValidateLaunch(executable, workingDirectory);
            CursorWindowsProcessInformation created = new CursorWindowsProcessInformation();
            WithPassword(pointer => created = native.CreateSuspended(userName, pointer, executable,
                command.ToString(), workingDirectory, environmentBlock));
            process = created.Process; thread = created.Thread; leaderStarted = true;
            Require(process != IntPtr.Zero && thread != IntPtr.Zero && created.ProcessId > 0, "PROCESS_CREATE");
            native.VerifyProcess(process, expectedSid, executable);
            native.AssignJob(job, process);
            native.VerifyJob(job, process);
            native.Resume(thread);
            native.Close(thread); thread = IntPtr.Zero;
            return created.ProcessId;
        }
        catch (Exception error)
        {
            CursorWindowsSessionException primary = Fixed(error, "PROCESS_START");
            try { Require(TerminateAndWait(5000), "PROCESS_CLEANUP"); }
            catch { primary.CleanupErrorCode = "CURSOR_APP_WINDOWS_SESSION_PROCESS_CLEANUP"; }
            throw primary;
        }
    }

    private void ReapLeader()
    {
        uint result;
        if (process != IntPtr.Zero && native.TryGetExit(process, out result))
        {
            exitCode = result; leaderExited = true;
            if (thread != IntPtr.Zero) { native.Close(thread); thread = IntPtr.Zero; }
            native.Close(process); process = IntPtr.Zero;
        }
    }

    public CursorWindowsSessionState GetState()
    {
        try
        {
            if (!closed) ReapLeader();
            uint active = job == IntPtr.Zero ? 0 : native.ActiveProcesses(job);
            return new CursorWindowsSessionState { LeaderStarted = leaderStarted, LeaderExited = leaderExited,
                ExitCode = exitCode, ActiveProcesses = active, ProcessesClosed = active == 0 && process == IntPtr.Zero && thread == IntPtr.Zero,
                ProfileCreationAttempted = profileCreationAttempted, ProfileCreated = profileCreated,
                ProfileLoaded = profile != IntPtr.Zero, ProfileDeleted = profileDeleted, Closed = closed };
        }
        catch (Exception error) { throw Fixed(error, "PROCESS_QUERY"); }
    }

    public bool WaitForEmpty(int timeoutMs)
    {
        Require(timeoutMs >= 0 && timeoutMs <= 300000, "ARGUMENTS");
        Stopwatch clock = Stopwatch.StartNew();
        do
        {
            if (GetState().ProcessesClosed) return true;
            long remaining = timeoutMs - clock.ElapsedMilliseconds;
            if (remaining <= 0) return false;
            Thread.Sleep((int)Math.Min(25, remaining));
        } while (true);
    }

    public bool TerminateAndWait(int timeoutMs)
    {
        try
        {
            Require(timeoutMs >= 0 && timeoutMs <= 300000, "ARGUMENTS");
            closing = true;
            if (GetState().ProcessesClosed) return true;
            if (job != IntPtr.Zero) native.TerminateJob(job);
            ReapLeader();
            if (process != IntPtr.Zero) native.TerminateProcess(process);
            return WaitForEmpty(timeoutMs);
        }
        catch (Exception error) { throw Fixed(error, "PROCESS_TERMINATE"); }
    }

    public void UnloadProfile()
    {
        try
        {
            closing = true;
            Require(GetState().ProcessesClosed, "JOB_BUSY");
            if (profile != IntPtr.Zero) native.UnloadProfile(token, ref profile);
        }
        catch (Exception error) { throw Fixed(error, "PROFILE_UNLOAD"); }
    }

    public void DeleteProfile()
    {
        try
        {
            closing = true;
            Require(GetState().ProcessesClosed, "JOB_BUSY");
            Require(profile == IntPtr.Zero, "PROFILE_LOADED");
            if (profileDeleted || !profileCreationAttempted) return;
            Require(profileCreated && ProfilePath != null, "PROFILE_OWNERSHIP");
            native.VerifyProfile(token, expectedSid, ProfilePath, false);
            native.DeleteProfile(expectedSid, ProfilePath);
            profileDeleted = true;
        }
        catch (Exception error) { throw Fixed(error, "PROFILE_DELETE"); }
    }

    public void Close()
    {
        try
        {
            if (closed) return;
            closing = true;
            Require(GetState().ProcessesClosed, "JOB_BUSY");
            Require(profile == IntPtr.Zero, "PROFILE_LOADED");
            Require(!profileCreationAttempted || profileDeleted, "PROFILE_OWNERSHIP");
            if (job != IntPtr.Zero) { native.Close(job); job = IntPtr.Zero; }
            if (token != IntPtr.Zero) { native.Close(token); token = IntPtr.Zero; }
            password.Dispose(); closed = true;
            GC.SuppressFinalize(this);
        }
        catch (Exception error) { throw Fixed(error, "HANDLE_CLOSE"); }
    }

    ~CursorWindowsOwnedSession()
    {
        // Last-handle job closure is a crash fallback, never cleanup evidence.
        foreach (IntPtr handle in new[] { job, thread, process, token })
            if (handle != IntPtr.Zero) try { native.Close(handle); } catch { }
        if (password != null) password.Dispose();
    }
}

internal interface ICursorWindowsSessionNative
{
    void CreateJob(ref IntPtr job);
    void Authenticate(string userName, string sid, IntPtr password, ref IntPtr token);
    string CreateProfile(string userName, string sid);
    void LoadProfile(IntPtr token, string userName, ref IntPtr profile);
    void VerifyProfile(IntPtr token, string sid, string path, bool loaded);
    void ValidateLaunch(string executable, string workingDirectory);
    CursorWindowsProcessInformation CreateSuspended(string userName, IntPtr password, string executable, string command, string cwd, string environment);
    void VerifyProcess(IntPtr process, string sid, string executable);
    void AssignJob(IntPtr job, IntPtr process);
    void VerifyJob(IntPtr job, IntPtr process);
    void Resume(IntPtr thread);
    bool TryGetExit(IntPtr process, out uint exitCode);
    uint ActiveProcesses(IntPtr job);
    void TerminateJob(IntPtr job);
    void TerminateProcess(IntPtr process);
    void UnloadProfile(IntPtr token, ref IntPtr profile);
    void DeleteProfile(string sid, string path);
    void Close(IntPtr handle);
}

[StructLayout(LayoutKind.Sequential)]
internal struct CursorWindowsProcessInformation { internal IntPtr Process, Thread; internal uint ProcessId, ThreadId; }

internal sealed class CursorWindowsSessionNative : ICursorWindowsSessionNative
{
    private const uint KillOnJobClose = 0x2000;
    private static void Check(bool value, string code) { CursorWindowsOwnedSession.Require(value, code); }
    private static string ProfileKey(string sid) { return @"SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList\" + sid; }

    public void CreateJob(ref IntPtr job)
    {
        job = Native.CreateJobObjectW(IntPtr.Zero, null);
        Check(job != IntPtr.Zero, "JOB_CREATE");
        Native.JobLimits limits = new Native.JobLimits(); limits.Basic.Flags = KillOnJobClose;
        Check(Native.SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf<Native.JobLimits>()), "JOB_LIMITS");
        uint flags;
        Check(Native.GetHandleInformation(job, out flags) && flags == 0, "JOB_HANDLE");
        VerifyLimits(job);
    }

    private static void VerifyLimits(IntPtr job)
    {
        Native.JobLimits limits; uint length;
        Check(Native.QueryJobLimits(job, 9, out limits, (uint)Marshal.SizeOf<Native.JobLimits>(), out length) &&
            length == Marshal.SizeOf<Native.JobLimits>() && limits.Basic.Flags == KillOnJobClose, "JOB_LIMITS");
    }

    private static void VerifyToken(IntPtr token, string expectedSid)
    {
        using (WindowsIdentity identity = new WindowsIdentity(token))
            Check(identity.User != null && identity.User.Value == expectedSid, "TOKEN_IDENTITY");
        uint bytes;
        Check(!Native.GetTokenInformation(token, 2, IntPtr.Zero, 0, out bytes) && Marshal.GetLastWin32Error() == 122 &&
            bytes >= 4 && bytes <= 65536, "TOKEN_GROUPS");
        IntPtr buffer = Marshal.AllocHGlobal((int)bytes);
        try
        {
            uint returned;
            Check(Native.GetTokenInformation(token, 2, buffer, bytes, out returned) && returned <= bytes, "TOKEN_GROUPS");
            uint count = unchecked((uint)Marshal.ReadInt32(buffer));
            int offset = (int)Marshal.OffsetOf<Native.TokenGroups>("First");
            int size = Marshal.SizeOf<Native.SidAndAttributes>();
            Check(count <= 4096 && offset + (long)count * size <= returned, "TOKEN_GROUPS");
            for (int index = 0; index < count; index++)
            {
                Native.SidAndAttributes group = Marshal.PtrToStructure<Native.SidAndAttributes>(IntPtr.Add(buffer, offset + index * size));
                // Do not filter deny-only groups as WindowsIdentity.Groups does.
                Check(new SecurityIdentifier(group.Sid).Value != "S-1-5-32-544", "TOKEN_ADMIN");
            }
        }
        finally { Marshal.FreeHGlobal(buffer); }
    }

    public void Authenticate(string userName, string sid, IntPtr password, ref IntPtr token)
    {
        SecurityIdentifier account = (SecurityIdentifier)new NTAccount(Environment.MachineName, userName).Translate(typeof(SecurityIdentifier));
        Check(account.Value == sid, "ACCOUNT_IDENTITY");
        Check(Native.LogonUserW(userName, Environment.MachineName, password, 2, 0, out token), "LOGON");
        VerifyToken(token, sid);
    }

    public string CreateProfile(string userName, string sid)
    {
        using (RegistryKey existing = Registry.LocalMachine.OpenSubKey(ProfileKey(sid))) Check(existing == null, "PROFILE_EXISTS");
        using (RegistryKey existing = Registry.Users.OpenSubKey(sid)) Check(existing == null, "PROFILE_EXISTS");
        StringBuilder path = new StringBuilder(32768);
        int result = Native.CreateProfile(sid, userName, path, (uint)path.Capacity);
        if (result != 0) throw new CursorWindowsSessionException(result == unchecked((int)0x800700B7) ? "PROFILE_EXISTS" : "PROFILE_CREATE")
            { NativeHResult = unchecked((uint)result) };
        return path.ToString();
    }

    private static void WithProfilePrivileges(Action action)
    {
        IntPtr token = IntPtr.Zero;
        Native.TokenPrivileges previous = new Native.TokenPrivileges();
        bool adjusted = false;
        CursorWindowsSessionException primary = null;
        try
        {
            Check(Native.OpenProcessToken(Native.GetCurrentProcess(), 0x28, out token), "PROFILE_PRIVILEGE");
            Native.TokenPrivileges requested = new Native.TokenPrivileges(); requested.Count = 2;
            Check(Native.LookupPrivilegeValueW(null, "SeBackupPrivilege", out requested.First.Luid) &&
                Native.LookupPrivilegeValueW(null, "SeRestorePrivilege", out requested.Second.Luid), "PROFILE_PRIVILEGE");
            requested.First.Attributes = 2; requested.Second.Attributes = 2;
            uint returned;
            bool result = Native.AdjustTokenPrivileges(token, false, ref requested, (uint)Marshal.SizeOf<Native.TokenPrivileges>(), out previous, out returned);
            int error = Marshal.GetLastWin32Error();
            adjusted = result;
            Check(result && error == 0 && previous.Count <= 2, "PROFILE_PRIVILEGE");
            action();
        }
        catch (Exception error) { primary = error as CursorWindowsSessionException ?? new CursorWindowsSessionException("PROFILE_PRIVILEGE"); }
        finally
        {
            if (adjusted)
            {
                Native.TokenPrivileges ignored; uint returned;
                bool restored = Native.AdjustTokenPrivileges(token, false, ref previous, (uint)Marshal.SizeOf<Native.TokenPrivileges>(), out ignored, out returned);
                if (!restored || Marshal.GetLastWin32Error() != 0)
                {
                    if (primary == null) primary = new CursorWindowsSessionException("PRIVILEGE_RESTORE");
                    primary.CleanupErrorCode = "CURSOR_APP_WINDOWS_SESSION_PRIVILEGE_RESTORE";
                }
            }
            if (token != IntPtr.Zero && !Native.CloseHandle(token))
            {
                if (primary == null) primary = new CursorWindowsSessionException("HANDLE_CLOSE");
                primary.CleanupErrorCode = "CURSOR_APP_WINDOWS_SESSION_HANDLE_CLOSE";
            }
        }
        if (primary != null) throw primary;
    }

    public void LoadProfile(IntPtr token, string userName, ref IntPtr profile)
    {
        Native.ProfileInfo info = new Native.ProfileInfo();
        info.Size = Marshal.SizeOf<Native.ProfileInfo>(); info.Flags = 1; info.UserName = userName;
        bool loaded = false;
        try { WithProfilePrivileges(() => { Check(Native.LoadUserProfileW(token, ref info), "PROFILE_LOAD"); loaded = true; }); }
        finally { if (loaded) profile = info.Profile; }
        Check(profile != IntPtr.Zero, "PROFILE_LOAD");
    }

    public void VerifyProfile(IntPtr token, string sid, string path, bool loaded)
    {
        ValidatePath(path, true);
        StringBuilder actual = new StringBuilder(32768); uint size = (uint)actual.Capacity;
        Check(Native.GetUserProfileDirectoryW(token, actual, ref size) && String.Equals(path, actual.ToString(), StringComparison.OrdinalIgnoreCase), "PROFILE_PATH");
        using (RegistryKey key = Registry.LocalMachine.OpenSubKey(ProfileKey(sid)))
            Check(key != null && String.Equals(key.GetValue("ProfileImagePath", null, RegistryValueOptions.DoNotExpandEnvironmentNames) as string,
                path, StringComparison.OrdinalIgnoreCase), "PROFILE_OWNERSHIP");
        using (RegistryKey key = Registry.Users.OpenSubKey(sid)) Check((key != null) == loaded, "PROFILE_HIVE");
    }

    private static void ValidatePath(string path, bool directory)
    {
        Check(path != null && Regex.IsMatch(path, @"\A[A-Za-z]:\\") && path.IndexOf('\0') < 0 &&
            String.Equals(Path.GetFullPath(path), path, StringComparison.OrdinalIgnoreCase), "PATH");
        FileAttributes attributes = File.GetAttributes(path);
        Check(((attributes & FileAttributes.Directory) != 0) == directory, "PATH");
        for (string cursor = path; cursor != null; cursor = Path.GetDirectoryName(cursor))
            Check((File.GetAttributes(cursor) & FileAttributes.ReparsePoint) == 0, "PATH");
    }

    public void ValidateLaunch(string executable, string workingDirectory)
    { ValidatePath(executable, false); ValidatePath(workingDirectory, true); }

    public CursorWindowsProcessInformation CreateSuspended(string userName, IntPtr password, string executable,
        string command, string cwd, string environment)
    {
        IntPtr block = Marshal.StringToHGlobalUni(environment);
        try
        {
            Native.StartupInfo startup = new Native.StartupInfo(); startup.Size = Marshal.SizeOf<Native.StartupInfo>();
            startup.Flags = 1; startup.ShowWindow = 0;
            CursorWindowsProcessInformation created;
            // Explicit profile holder, not LOGON_WITH_PROFILE tied to a short-lived leader.
            Check(Native.CreateProcessWithLogonW(userName, Environment.MachineName, password, 0, executable,
                new StringBuilder(command), 0x00000004 | 0x00000400 | 0x08000000, block, cwd, ref startup, out created), "PROCESS_CREATE");
            return created;
        }
        finally { Marshal.FreeHGlobal(block); }
    }

    public void VerifyProcess(IntPtr process, string sid, string executable)
    {
        IntPtr token;
        Check(Native.OpenProcessToken(process, 8, out token), "TOKEN_QUERY");
        try { VerifyToken(token, sid); } finally { Close(token); }
        StringBuilder actual = new StringBuilder(32768); uint length = (uint)actual.Capacity;
        Check(Native.QueryFullProcessImageNameW(process, 0, actual, ref length) &&
            String.Equals(executable, actual.ToString(), StringComparison.OrdinalIgnoreCase), "PROCESS_IMAGE");
        Check(Native.WaitForSingleObject(process, 0) == 258, "PROCESS_EXITED");
    }

    public void AssignJob(IntPtr job, IntPtr process) { Check(Native.AssignProcessToJobObject(job, process), "JOB_ASSIGN"); }
    public void VerifyJob(IntPtr job, IntPtr process)
    {
        bool member;
        Check(Native.IsProcessInJob(process, job, out member) && member, "JOB_MEMBERSHIP");
        VerifyLimits(job);
        Check(ActiveProcesses(job) == 1, "JOB_MEMBERSHIP");
    }
    public void Resume(IntPtr thread) { Check(Native.ResumeThread(thread) == 1, "PROCESS_RESUME"); }
    public bool TryGetExit(IntPtr process, out uint exitCode)
    {
        exitCode = 0; uint result = Native.WaitForSingleObject(process, 0);
        if (result == 258) return false;
        Check(result == 0 && Native.GetExitCodeProcess(process, out exitCode), "PROCESS_QUERY");
        return true;
    }
    public uint ActiveProcesses(IntPtr job)
    {
        Native.JobAccounting accounting; uint length;
        Check(Native.QueryJobAccounting(job, 1, out accounting, (uint)Marshal.SizeOf<Native.JobAccounting>(), out length) &&
            length == Marshal.SizeOf<Native.JobAccounting>(), "JOB_QUERY");
        return accounting.ActiveProcesses;
    }
    public void TerminateJob(IntPtr job) { Check(Native.TerminateJobObject(job, 1), "JOB_TERMINATE"); }
    public void TerminateProcess(IntPtr process) { Check(Native.TerminateProcess(process, 1), "PROCESS_TERMINATE"); }
    public void UnloadProfile(IntPtr token, ref IntPtr profile)
    {
        IntPtr held = profile; bool unloaded = false;
        try { WithProfilePrivileges(() => { Check(Native.UnloadUserProfile(token, held), "PROFILE_UNLOAD"); unloaded = true; }); }
        finally { if (unloaded) profile = IntPtr.Zero; }
    }
    public void DeleteProfile(string sid, string path)
    {
        Check(Native.DeleteProfileW(sid, path, null), "PROFILE_DELETE");
        try
        {
            using (RegistryKey key = Registry.LocalMachine.OpenSubKey(ProfileKey(sid))) Check(key == null, "PROFILE_DELETE_VERIFY");
            using (RegistryKey key = Registry.Users.OpenSubKey(sid)) Check(key == null, "PROFILE_DELETE_VERIFY");
            try { File.GetAttributes(path); }
            catch (FileNotFoundException) { return; }
            catch (DirectoryNotFoundException) { return; }
        }
        catch { throw new CursorWindowsSessionException("PROFILE_DELETE_VERIFY"); }
        throw new CursorWindowsSessionException("PROFILE_DELETE_VERIFY");
    }
    public void Close(IntPtr handle) { Check(Native.CloseHandle(handle), "HANDLE_CLOSE"); }

    private static class Native
    {
        [StructLayout(LayoutKind.Sequential)] internal struct Luid { internal uint Low; internal int High; }
        [StructLayout(LayoutKind.Sequential)] internal struct LuidAndAttributes { internal Luid Luid; internal uint Attributes; }
        [StructLayout(LayoutKind.Sequential)] internal struct TokenPrivileges { internal uint Count; internal LuidAndAttributes First, Second; }
        [StructLayout(LayoutKind.Sequential)] internal struct SidAndAttributes { internal IntPtr Sid; internal uint Attributes; }
        [StructLayout(LayoutKind.Sequential)] internal struct TokenGroups { internal uint Count; internal SidAndAttributes First; }
        [StructLayout(LayoutKind.Sequential)] internal struct JobBasicLimits
        {
            internal long ProcessTime, JobTime; internal uint Flags; internal UIntPtr MinimumWorkingSet, MaximumWorkingSet;
            internal uint ActiveProcessLimit; internal UIntPtr Affinity; internal uint PriorityClass, SchedulingClass;
        }
        [StructLayout(LayoutKind.Sequential)] internal struct IoCounters { internal ulong A, B, C, D, E, F; }
        [StructLayout(LayoutKind.Sequential)] internal struct JobLimits
        { internal JobBasicLimits Basic; internal IoCounters Io; internal UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory; }
        [StructLayout(LayoutKind.Sequential)] internal struct JobAccounting
        { internal long A, B, C, D; internal uint PageFaults, TotalProcesses, ActiveProcesses, TerminatedProcesses; }
        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] internal struct ProfileInfo
        {
            internal int Size, Flags; internal string UserName, ProfilePath, DefaultPath, ServerName, PolicyPath; internal IntPtr Profile;
        }
        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] internal struct StartupInfo
        {
            internal int Size; internal string Reserved, Desktop, Title;
            internal uint X, Y, XSize, YSize, XCountChars, YCountChars, FillAttribute, Flags;
            internal ushort ShowWindow, ReservedSize; internal IntPtr ReservedPointer, StandardInput, StandardOutput, StandardError;
        }
        [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] internal static extern bool LogonUserW(string user, string domain, IntPtr password, int type, int provider, out IntPtr token);
        [DllImport("advapi32.dll", SetLastError = true)] internal static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
        [DllImport("advapi32.dll", SetLastError = true)] internal static extern bool GetTokenInformation(IntPtr token, int kind, IntPtr data, uint size, out uint returned);
        [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] internal static extern bool LookupPrivilegeValueW(string system, string name, out Luid luid);
        [DllImport("advapi32.dll", SetLastError = true)] internal static extern bool AdjustTokenPrivileges(IntPtr token, bool all, ref TokenPrivileges requested, uint size, out TokenPrivileges previous, out uint returned);
        [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] internal static extern bool CreateProcessWithLogonW(string user, string domain, IntPtr password, uint logonFlags, string application, StringBuilder command, uint flags, IntPtr environment, string cwd, ref StartupInfo startup, out CursorWindowsProcessInformation created);
        [DllImport("userenv.dll", CharSet = CharSet.Unicode, ExactSpelling = true)] internal static extern int CreateProfile(string sid, string user, StringBuilder path, uint capacity);
        [DllImport("userenv.dll", CharSet = CharSet.Unicode, SetLastError = true)] internal static extern bool LoadUserProfileW(IntPtr token, ref ProfileInfo profile);
        [DllImport("userenv.dll", SetLastError = true)] internal static extern bool UnloadUserProfile(IntPtr token, IntPtr profile);
        [DllImport("userenv.dll", CharSet = CharSet.Unicode, SetLastError = true)] internal static extern bool GetUserProfileDirectoryW(IntPtr token, StringBuilder path, ref uint capacity);
        [DllImport("userenv.dll", CharSet = CharSet.Unicode, SetLastError = true)] internal static extern bool DeleteProfileW(string sid, string path, string computer);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] internal static extern IntPtr CreateJobObjectW(IntPtr attributes, string name);
        [DllImport("kernel32.dll", SetLastError = true)] internal static extern bool SetInformationJobObject(IntPtr job, int kind, ref JobLimits info, uint size);
        [DllImport("kernel32.dll", EntryPoint = "QueryInformationJobObject", SetLastError = true)] internal static extern bool QueryJobLimits(IntPtr job, int kind, out JobLimits info, uint size, out uint returned);
        [DllImport("kernel32.dll", EntryPoint = "QueryInformationJobObject", SetLastError = true)] internal static extern bool QueryJobAccounting(IntPtr job, int kind, out JobAccounting info, uint size, out uint returned);
        [DllImport("kernel32.dll", SetLastError = true)] internal static extern bool GetHandleInformation(IntPtr handle, out uint flags);
        [DllImport("kernel32.dll", SetLastError = true)] internal static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
        [DllImport("kernel32.dll", SetLastError = true)] internal static extern bool IsProcessInJob(IntPtr process, IntPtr job, out bool member);
        [DllImport("kernel32.dll", SetLastError = true)] internal static extern bool TerminateJobObject(IntPtr job, uint code);
        [DllImport("kernel32.dll", SetLastError = true)] internal static extern bool TerminateProcess(IntPtr process, uint code);
        [DllImport("kernel32.dll", SetLastError = true)] internal static extern uint ResumeThread(IntPtr thread);
        [DllImport("kernel32.dll", SetLastError = true)] internal static extern uint WaitForSingleObject(IntPtr handle, uint timeout);
        [DllImport("kernel32.dll", SetLastError = true)] internal static extern bool GetExitCodeProcess(IntPtr process, out uint code);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] internal static extern bool QueryFullProcessImageNameW(IntPtr process, uint flags, StringBuilder name, ref uint size);
        [DllImport("kernel32.dll")] internal static extern IntPtr GetCurrentProcess();
        [DllImport("kernel32.dll", SetLastError = true)] internal static extern bool CloseHandle(IntPtr handle);
    }
}
