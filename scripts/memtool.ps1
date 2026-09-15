# memtool.ps1 - long-lived helper for the Idle Saver extension.
# Reads one JSON request per line on stdin, writes one JSON reply per line on stdout.
# Kept resident so we pay the Add-Type / CIM startup cost once, not on every trim.

$ErrorActionPreference = 'Stop'

Add-Type -Namespace IdleSaver -Name Native -MemberDefinition @'
[StructLayout(LayoutKind.Sequential)]
public struct PROCESS_POWER_THROTTLING_STATE {
    public uint Version;
    public uint ControlMask;
    public uint StateMask;
}

[DllImport("kernel32.dll", SetLastError = true)]
public static extern IntPtr OpenProcess(uint dwDesiredAccess, bool bInheritHandle, int dwProcessId);

[DllImport("kernel32.dll", SetLastError = true)]
public static extern bool CloseHandle(IntPtr hObject);

[DllImport("psapi.dll", SetLastError = true)]
public static extern bool EmptyWorkingSet(IntPtr hProcess);

[DllImport("kernel32.dll", SetLastError = true)]
public static extern bool SetProcessInformation(IntPtr hProcess, int ProcessInformationClass,
    ref PROCESS_POWER_THROTTLING_STATE ProcessInformation, int ProcessInformationSize);

[DllImport("kernel32.dll", SetLastError = true)]
public static extern bool SetPriorityClass(IntPtr hProcess, uint dwPriorityClass);
'@

# PROCESS_SET_QUOTA | PROCESS_QUERY_INFORMATION | PROCESS_SET_INFORMATION | PROCESS_QUERY_LIMITED_INFORMATION
$ACCESS = 0x0100 -bor 0x0400 -bor 0x0200 -bor 0x1000

$PROC_POWER_THROTTLING   = 4      # ProcessInformationClass
$THROTTLING_VERSION      = 1
$EXECUTION_SPEED         = 0x1
$IDLE_PRIORITY_CLASS     = 0x40
$NORMAL_PRIORITY_CLASS   = 0x20

function Use-Handle([int]$ProcId, [scriptblock]$Body) {
    $h = [IdleSaver.Native]::OpenProcess($ACCESS, $false, $ProcId)
    if ($h -eq [IntPtr]::Zero) { return $false }
    try { return (& $Body $h) } finally { [void][IdleSaver.Native]::CloseHandle($h) }
}

function Invoke-Trim([int[]]$Pids) {
    # EmptyWorkingSet: evict resident pages. They land on the standby list, so a
    # quick return to work re-faults them from RAM rather than disk; a long
    # absence lets Windows reuse or page them out. This is the memory lever.
    $done = 0
    foreach ($p in $Pids) {
        $ok = Use-Handle $p { param($h) [IdleSaver.Native]::EmptyWorkingSet($h) }
        if ($ok) { $done++ }
    }
    return $done
}

function Set-Throttle([int[]]$Pids, [bool]$Eco) {
    # EcoQoS + idle priority is what Task Manager labels "Efficiency mode".
    # CPU lever, not memory - it stops background processes fighting you for
    # cycles while the machine is under pressure.
    $done = 0
    foreach ($p in $Pids) {
        $ok = Use-Handle $p {
            param($h)
            $state = New-Object IdleSaver.Native+PROCESS_POWER_THROTTLING_STATE
            $state.Version = $THROTTLING_VERSION
            if ($Eco) {
                $state.ControlMask = $EXECUTION_SPEED
                $state.StateMask   = $EXECUTION_SPEED
            } else {
                $state.ControlMask = 0   # hand control back to the system
                $state.StateMask   = 0
            }
            $size = [System.Runtime.InteropServices.Marshal]::SizeOf($state)
            $a = [IdleSaver.Native]::SetProcessInformation($h, $PROC_POWER_THROTTLING, [ref]$state, $size)
            $prio = if ($Eco) { $IDLE_PRIORITY_CLASS } else { $NORMAL_PRIORITY_CLASS }
            $b = [IdleSaver.Native]::SetPriorityClass($h, $prio)
            return ($a -and $b)
        }
        if ($ok) { $done++ }
    }
    return $done
}

function Get-Tree([int]$RootPid, [string[]]$AlsoNamed) {
    # Walk up from the extension-host pid to the top-most Code.exe, then collect
    # every descendant. That sweeps in renderers, the pty host, language servers,
    # and any dart/node process VS Code spawned.
    $all = @(Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,Name,WorkingSetSize)
    $byPid    = @{}
    $children = @{}
    foreach ($p in $all) {
        $byPid[[int]$p.ProcessId] = $p
        $par = [int]$p.ParentProcessId
        if (-not $children.ContainsKey($par)) { $children[$par] = New-Object System.Collections.ArrayList }
        [void]$children[$par].Add([int]$p.ProcessId)
    }

    $root = $RootPid
    for ($i = 0; $i -lt 12; $i++) {
        $cur = $byPid[$root]
        if (-not $cur) { break }
        $par = $byPid[[int]$cur.ParentProcessId]
        if (-not $par) { break }
        if ($par.Name -notmatch '^(Code|Code - Insiders|VSCodium)\.exe$') { break }
        $root = [int]$par.ProcessId
    }

    $seen  = @{}
    $stack = New-Object System.Collections.Stack
    $stack.Push($root)
    while ($stack.Count -gt 0) {
        $cur = $stack.Pop()
        if ($seen.ContainsKey($cur)) { continue }
        $seen[$cur] = $true
        if ($children.ContainsKey($cur)) { foreach ($c in $children[$cur]) { $stack.Push($c) } }
    }

    foreach ($n in $AlsoNamed) {
        foreach ($p in $all) {
            if ($p.Name -ieq $n) { $seen[[int]$p.ProcessId] = $true }
        }
    }

    $out = @()
    foreach ($k in $seen.Keys) {
        $p = $byPid[$k]
        if ($p) { $out += [pscustomobject]@{ pid = $k; name = $p.Name; ws = [long]$p.WorkingSetSize } }
    }
    return ,@($out)
}

function Get-Stats([int[]]$Pids) {
    $total = [long]0
    foreach ($p in $Pids) {
        try { $total += [long](Get-Process -Id $p -ErrorAction Stop).WorkingSet64 } catch { }
    }
    $os = Get-CimInstance Win32_OperatingSystem -Property FreePhysicalMemory,TotalVisibleMemorySize
    return [pscustomobject]@{
        workingSet = $total
        freeBytes  = [long]$os.FreePhysicalMemory * 1024
        totalBytes = [long]$os.TotalVisibleMemorySize * 1024
    }
}

# ---- request loop -----------------------------------------------------------
while ($true) {
    $line = [Console]::In.ReadLine()
    if ($null -eq $line) { break }
    if ([string]::IsNullOrWhiteSpace($line)) { continue }

    $id = 0
    try {
        $req = $line | ConvertFrom-Json
        $id  = [int]$req.id
        $procIds = @()
        if ($req.pids) { $procIds = @($req.pids | ForEach-Object { [int]$_ }) }

        switch ($req.cmd) {
            'tree'    { $data = Get-Tree ([int]$req.rootPid) @($req.alsoNamed) }
            'trim'    { $data = Invoke-Trim $procIds }
            'eco'     { $data = Set-Throttle $procIds $true }
            'restore' { $data = Set-Throttle $procIds $false }
            'stats'   { $data = Get-Stats $procIds }
            'ping'    { $data = 'pong' }
            default   { throw "unknown command: $($req.cmd)" }
        }

        $reply = [pscustomobject]@{ id = $id; ok = $true; data = $data }
    } catch {
        $reply = [pscustomobject]@{ id = $id; ok = $false; error = $_.Exception.Message }
    }

    [Console]::Out.WriteLine(($reply | ConvertTo-Json -Depth 6 -Compress))
    [Console]::Out.Flush()
}
