import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const source = async () => (await readFile(new URL("./cursor-app-windows-owned-session.cs", import.meta.url), "utf8")).replaceAll("\r\n", "\n");

test("Windows session binds suspended identity and job before resume without breakaway or PID cleanup", async () => {
  const text = await source();
  const start = text.slice(text.indexOf("public uint StartBootstrap"), text.indexOf("private void ReapLeader"));
  const steps = ["native.CreateSuspended", "native.VerifyProcess", "native.AssignJob", "native.VerifyJob", "native.Resume"];
  for (let index = 1; index < steps.length; index++) assert.ok(start.indexOf(steps[index - 1]) < start.indexOf(steps[index]));
  assert.match(text, /CreateJobObjectW\(IntPtr.Zero, null\)/);
  assert.match(text, /GetHandleInformation\(job, out flags\) && flags == 0/);
  assert.match(text, /limits.Basic.Flags == KillOnJobClose/);
  assert.match(text, /0x00000004 \| 0x00000400 \| 0x08000000/);
  assert.match(text, /CreateProcessWithLogonW\(userName, Environment.MachineName, password, 0, executable/);
  assert.doesNotMatch(text, /0x01000000|0x00000800|0x00001000|JobObjectBasicUIRestrictions/);
  assert.doesNotMatch(text, /GetProcessById|GetProcesses|OpenProcess\(|CreateProcessAsUser|LOGON_NETCREDENTIALS_ONLY/);
});

test("profile authority, complete token groups, secret lifetime and privilege restoration remain explicit", async () => {
  const text = await source();
  assert.match(text, /if \(result != 0\) throw new CursorWindowsSessionException\(result == unchecked\(\(int\)0x800700B7\)/);
  assert.match(text, /public uint\? NativeHResult \{ get; internal set; \}/);
  const create = text.slice(text.indexOf("public string CreateProfile(string userName, string sid)"), text.indexOf("private static void WithProfilePrivileges"));
  assert.match(create, /StringBuilder path = new StringBuilder\(260\);/);
  assert.match(create, /Native\.CreateProfile\(sid, userName, path, \(uint\)path\.Capacity\)/);
  assert.match(create, /NativeHResult = unchecked\(\(uint\)result\)/);
  assert.equal((text.match(/NativeHResult\s*=/g) ?? []).length, 1);
  assert.match(text, /GetUserProfileDirectoryW\(token, actual, ref size\)/);
  assert.match(text, /Registry.Users.OpenSubKey\(sid\)/);
  assert.match(text, /DeleteProfileW\(sid, path, null\)/);
  const remove = text.slice(text.indexOf("public void DeleteProfile(string sid, string path)"), text.indexOf("public void Close(IntPtr handle)"));
  assert.match(remove, /Registry.LocalMachine.OpenSubKey\(ProfileKey\(sid\)\)/);
  assert.match(remove, /Registry.Users.OpenSubKey\(sid\)/);
  assert.match(remove, /File.GetAttributes\(path\)/);
  assert.match(remove, /catch \(FileNotFoundException\) \{ return; \}/);
  assert.match(remove, /catch \(DirectoryNotFoundException\) \{ return; \}/);
  assert.match(remove, /"PROFILE_DELETE_VERIFY"/);
  assert.doesNotMatch(text, /Directory.Exists|Directory.Delete|DeleteSubKey/);
  assert.doesNotMatch(text, /info.ProfilePath\s*=/);
  assert.match(text, /GetTokenInformation\(token, 2,/);
  assert.match(text, /new SecurityIdentifier\(group.Sid\).Value != "S-1-5-32-544"/);
  assert.doesNotMatch(text, /identity.Groups|IsInRole/);
  assert.match(text, /finally \{ Marshal.ZeroFreeGlobalAllocUnicode\(pointer\); \}/);
  assert.doesNotMatch(text, /PtrToString|NetworkCredential|GetEnvironmentVariables|Console\./);
  assert.match(text, /"SeBackupPrivilege"/);
  assert.match(text, /"SeRestorePrivilege"/);
  assert.match(text, /Check\(result && error == 0 && previous.Count <= 2/);
  assert.match(text, /AdjustTokenPrivileges\(token, false, ref previous,/);
});

test("job wait uses one remaining-time snapshot and cannot pass a negative value to Sleep", async () => {
  const text = await source();
  const wait = text.slice(text.indexOf("public bool WaitForEmpty"), text.indexOf("public bool TerminateAndWait"));
  assert.equal((wait.match(/clock.ElapsedMilliseconds/g) ?? []).length, 1);
  assert.match(wait, /long remaining = timeoutMs - clock.ElapsedMilliseconds;\s*if \(remaining <= 0\) return false;\s*Thread.Sleep\(\(int\)Math.Min\(25, remaining\)\);/);
});

test("C# compiles and pure native fixtures prove lifecycle ordering, retained ownership and fixed failures", async (t) => {
  const available = spawnSync("pwsh", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "exit 0"],
    { encoding: "utf8", timeout: 10000 });
  if (available.error?.code === "ENOENT") return t.skip("PowerShell is not installed");
  assert.equal(available.status, 0);
  const fixture = String.raw`
internal sealed class CursorWindowsSessionFake : ICursorWindowsSessionNative
{
    internal readonly List<string> Calls = new List<string>();
    internal string Fail;
    internal CursorWindowsSessionException ProfileFailure;
    internal bool Exited, Hold, Loaded, FailAfterLoad, FailTermination, FailDeleteVerification;
    internal uint Active;
    internal string Command, EnvironmentText;
    private void Step(string value) { Calls.Add(value); if (Fail == value) throw new InvalidOperationException("private-account private-path private-password"); }
    public void CreateJob(ref IntPtr job) { job = (IntPtr)1; Step("job"); }
    public void Authenticate(string user, string sid, IntPtr secret, ref IntPtr token)
    { Step("authenticate"); if (Marshal.ReadInt16(secret) == 0) throw new Exception("empty"); token = (IntPtr)2; }
    public string CreateProfile(string user, string sid)
    { Step("createProfile"); if (ProfileFailure != null) throw ProfileFailure; return @"C:\Users\mxfixture"; }
    public void LoadProfile(IntPtr token, string user, ref IntPtr profile)
    {
        Step("loadProfile"); profile = (IntPtr)3; Loaded = true;
        if (FailAfterLoad) throw new CursorWindowsSessionException("PRIVILEGE_RESTORE");
    }
    public void VerifyProfile(IntPtr token, string sid, string path, bool loaded)
    { Step("verifyProfile"); if (Loaded != loaded) throw new Exception("hive mismatch"); }
    public void ValidateLaunch(string executable, string cwd) { Step("validateLaunch"); }
    public CursorWindowsProcessInformation CreateSuspended(string user, IntPtr secret, string executable, string command, string cwd, string environment)
    {
        Step("suspended"); Command = command; EnvironmentText = environment;
        return new CursorWindowsProcessInformation { Process = (IntPtr)4, Thread = (IntPtr)5, ProcessId = 42 };
    }
    public void VerifyProcess(IntPtr process, string sid, string executable) { Step("verifyProcess"); }
    public void AssignJob(IntPtr job, IntPtr process) { Step("assign"); Active = 1; }
    public void VerifyJob(IntPtr job, IntPtr process) { Step("verifyJob"); }
    public void Resume(IntPtr thread) { Step("resume"); }
    public bool TryGetExit(IntPtr process, out uint code) { Step("exit"); code = 0; return Exited; }
    public uint ActiveProcesses(IntPtr job) { Step("active"); return Active; }
    public void TerminateJob(IntPtr job)
    { Step("terminateJob"); if (FailTermination) throw new Exception("private-path"); if (!Hold) { Active = 0; Exited = true; } }
    public void TerminateProcess(IntPtr process) { Step("terminateProcess"); if (!Hold) Exited = true; }
    public void UnloadProfile(IntPtr token, ref IntPtr profile) { Step("unload"); profile = IntPtr.Zero; Loaded = false; }
    public void DeleteProfile(string sid, string path)
    { Step("delete"); if (FailDeleteVerification) throw new CursorWindowsSessionException("PROFILE_DELETE_VERIFY"); }
    public void Close(IntPtr handle) { Step("close:" + handle.ToInt32()); }
}

public static class CursorWindowsSessionFixture
{
    private static void Assert(bool value) { if (!value) throw new Exception("FIXTURE_ASSERTION"); }
    private static CursorWindowsOwnedSession New(CursorWindowsSessionFake fake)
    {
        using (SecureString password = new SecureString())
        {
            password.AppendChar('x'); password.MakeReadOnly();
            return new CursorWindowsOwnedSession("mxfixture", "S-1-5-21-1-2-3-1001", password, fake);
        }
    }
    private static Hashtable Env()
    {
        return new Hashtable { { "USERPROFILE", @"C:\Users\mxfixture" },
            { "APPDATA", @"C:\Users\mxfixture\AppData\Roaming" }, { "LOCALAPPDATA", @"C:\Users\mxfixture\AppData\Local" } };
    }
    private static void Start(CursorWindowsOwnedSession session)
    { Assert(session.StartBootstrap(@"C:\owned path\setup.exe", new[] { "/SILENT", @"/DIR=C:\owned path\" }, @"C:\Users\mxfixture", Env()) == 42); }
    private static CursorWindowsSessionException Fails(Action action, string code)
    {
        try { action(); } catch (CursorWindowsSessionException error)
        {
            Assert(error.Code == "CURSOR_APP_WINDOWS_SESSION_" + code && error.Message == error.Code && error.InnerException == null);
            return error;
        }
        throw new Exception("EXPECTED_FAILURE");
    }
    private static void Finish(CursorWindowsOwnedSession session)
    { Assert(session.TerminateAndWait(0)); session.UnloadProfile(); session.DeleteProfile(); session.Close(); }
    public static string[] Run()
    {
        List<string> passed = new List<string>();
        var fake = new CursorWindowsSessionFake(); var session = New(fake);
        session.CreateAndLoadProfile(); Start(session);
        string[] ordered = { "suspended", "verifyProcess", "assign", "verifyJob", "resume", "close:5" };
        for (int i = 1; i < ordered.Length; i++) Assert(fake.Calls.IndexOf(ordered[i - 1]) < fake.Calls.IndexOf(ordered[i]));
        Assert(fake.EnvironmentText.EndsWith("\0\0") && fake.Command.Contains("owned path"));
        Fails(() => Start(session), "STATE"); Assert(!fake.Calls.Contains("terminateJob"));
        fake.Exited = true;
        Assert(!session.WaitForEmpty(0) && session.GetState().LeaderExited && session.GetState().ActiveProcesses == 1);
        Fails(() => session.UnloadProfile(), "JOB_BUSY"); Assert(!fake.Calls.Contains("unload"));
        fake.Active = 0; Assert(session.WaitForEmpty(0)); Finish(session);
        session.UnloadProfile(); session.DeleteProfile(); session.Close();
        Assert(session.GetState().Closed && session.GetState().ExitCode == 0 && session.GetState().ProfileDeleted);
        passed.Add("leader-exit-is-not-job-empty");

        foreach (string point in new[] { "verifyProcess", "assign", "verifyJob" })
        {
            fake = new CursorWindowsSessionFake { Fail = point }; session = New(fake); session.CreateAndLoadProfile();
            Fails(() => Start(session), "PROCESS_START");
            Assert(!fake.Calls.Contains("resume") && session.GetState().ProcessesClosed && session.GetState().ProfileLoaded);
            fake.Fail = null; Finish(session);
        }
        passed.Add("suspended-failure-never-resumes");

        fake = new CursorWindowsSessionFake { Fail = "verifyJob", FailTermination = true }; session = New(fake); session.CreateAndLoadProfile();
        var failure = Fails(() => Start(session), "PROCESS_START");
        Assert(failure.CleanupErrorCode == "CURSOR_APP_WINDOWS_SESSION_PROCESS_CLEANUP" && !fake.Calls.Contains("resume"));
        Assert(session.GetState().ProfileLoaded && !session.GetState().ProcessesClosed);
        fake.Fail = null; fake.FailTermination = false; Finish(session); passed.Add("cleanup-error-preserves-primary-and-handles");

        fake = new CursorWindowsSessionFake(); session = New(fake); session.CreateAndLoadProfile(); Start(session);
        fake.Hold = true; Assert(!session.TerminateAndWait(0));
        Fails(() => session.UnloadProfile(), "JOB_BUSY"); Fails(() => session.DeleteProfile(), "JOB_BUSY"); Fails(() => session.Close(), "JOB_BUSY");
        Assert(!fake.Calls.Contains("unload") && !fake.Calls.Contains("delete") && !fake.Calls.Contains("close:1"));
        fake.Hold = false; Finish(session); passed.Add("unknown-closure-retains-every-owned-resource");

        fake = new CursorWindowsSessionFake { Fail = "createProfile" }; session = New(fake);
        Fails(() => session.CreateAndLoadProfile(), "PROFILE_PREPARE");
        Fails(() => session.DeleteProfile(), "PROFILE_OWNERSHIP"); Fails(() => session.Close(), "PROFILE_OWNERSHIP");
        Assert(!fake.Calls.Contains("delete") && !session.GetState().ProfileCreated);
        passed.Add("failed-create-does-not-authorize-delete");

        foreach (uint result in new uint[] { 0x80070005, 0x800700B7, 1 })
        {
            string code = result == 0x800700B7 ? "PROFILE_EXISTS" : "PROFILE_CREATE";
            fake = new CursorWindowsSessionFake { ProfileFailure = new CursorWindowsSessionException(code) { NativeHResult = result } };
            session = New(fake);
            failure = Fails(() => session.CreateAndLoadProfile(), code);
            Assert(failure.NativeHResult == result && Object.ReferenceEquals(failure, fake.ProfileFailure));
            Assert(!session.GetState().ProfileCreated && !fake.Calls.Contains("loadProfile"));
            Assert(Fails(() => session.DeleteProfile(), "PROFILE_OWNERSHIP").NativeHResult == null);
        }
        Assert(new CursorWindowsSessionException("PROFILE_CREATE").NativeHResult == null);
        passed.Add("create-profile-hresult-is-numeric-and-preserved");

        fake = new CursorWindowsSessionFake { Fail = "loadProfile" }; session = New(fake);
        Fails(() => session.CreateAndLoadProfile(), "PROFILE_PREPARE");
        Assert(session.GetState().ProfileCreated && !session.GetState().ProfileLoaded);
        fake.Fail = null; Finish(session); passed.Add("created-profile-cleaned-after-load-failure");

        fake = new CursorWindowsSessionFake { FailAfterLoad = true }; session = New(fake);
        Fails(() => session.CreateAndLoadProfile(), "PRIVILEGE_RESTORE");
        Assert(session.GetState().ProfileLoaded); Finish(session); passed.Add("partial-load-retains-original-handle");

        fake = new CursorWindowsSessionFake { Fail = "unload" }; session = New(fake); session.CreateAndLoadProfile();
        Fails(() => session.UnloadProfile(), "PROFILE_UNLOAD"); Fails(() => session.DeleteProfile(), "PROFILE_LOADED");
        Assert(!fake.Calls.Contains("delete")); fake.Fail = null; Finish(session); passed.Add("failed-unload-prevents-delete");

        fake = new CursorWindowsSessionFake { FailDeleteVerification = true }; session = New(fake); session.CreateAndLoadProfile();
        session.UnloadProfile(); Fails(() => session.DeleteProfile(), "PROFILE_DELETE_VERIFY");
        Assert(fake.Calls.Contains("delete") && !session.GetState().ProfileDeleted);
        Fails(() => session.Close(), "PROFILE_OWNERSHIP");
        Assert(!fake.Calls.Contains("close:1") && !fake.Calls.Contains("close:2"));
        passed.Add("unverified-delete-retains-owned-handles");

        fake = new CursorWindowsSessionFake(); session = New(fake); Finish(session); Finish(session);
        Assert(!fake.Calls.Contains("delete") && session.GetState().Closed); passed.Add("unused-session-cleanup-is-idempotent");

        fake = new CursorWindowsSessionFake(); session = New(fake); session.CreateAndLoadProfile();
        Hashtable wrong = Env(); wrong["USERPROFILE"] = @"C:\private-account";
        Fails(() => session.StartBootstrap(@"C:\setup.exe", new string[0], @"C:\cwd", wrong), "ENVIRONMENT");
        Assert(!fake.Calls.Contains("suspended")); Finish(session); passed.Add("native-profile-cannot-be-replaced-by-env");

        Assert(CursorWindowsOwnedSession.QuoteArgument("") == "\"\"");
        Assert(CursorWindowsOwnedSession.QuoteArgument(@"a b\") == "\"a b\\\\\"");
        Assert(CursorWindowsOwnedSession.QuoteArgument("a\"b") == "\"a\\\"b\"");
        passed.Add("argument-quoting");
        return passed.ToArray();
    }
}
`;
  const root = await mkdtemp(join(tmpdir(), "cursor-windows-session-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "fixture.cs"), (await source()) + fixture);
  const script = `$ErrorActionPreference='Stop'
try {
  Add-Type -Path (Join-Path $PSScriptRoot 'fixture.cs') -ErrorAction Stop
  ConvertTo-Json -InputObject @([CursorWindowsSessionFixture]::Run()) -Compress
} catch {
  $codes = @([regex]::Matches($_.Exception.Message, 'CS[0-9]{4}').Value | Select-Object -Unique)
  [Console]::WriteLine(('FIXTURE_FAILED ' + ($codes -join ',')))
  exit 1
}`;
  await writeFile(join(root, "fixture.ps1"), script);
  const result = spawnSync("pwsh", ["-NoLogo", "-NoProfile", "-NonInteractive", "-File", join(root, "fixture.ps1")],
    { encoding: "utf8", timeout: 30000, maxBuffer: 65536 });
  assert.equal(result.status, 0, result.stdout.trim());
  assert.equal(result.stderr, "");
  assert.doesNotMatch(result.stdout, /private-account|private-path|private-password/);
  assert.deepEqual(JSON.parse(result.stdout), ["leader-exit-is-not-job-empty", "suspended-failure-never-resumes", "cleanup-error-preserves-primary-and-handles",
    "unknown-closure-retains-every-owned-resource", "failed-create-does-not-authorize-delete", "create-profile-hresult-is-numeric-and-preserved",
    "created-profile-cleaned-after-load-failure", "partial-load-retains-original-handle",
    "failed-unload-prevents-delete", "unverified-delete-retains-owned-handles", "unused-session-cleanup-is-idempotent", "native-profile-cannot-be-replaced-by-env", "argument-quoting"]);
});
