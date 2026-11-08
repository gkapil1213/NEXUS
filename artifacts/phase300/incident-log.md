# Phase 300 — Incident log

Incidents that occurred during Phase 300 implementation and what was done
about each.

## Incident 1 — .NET CWD pitfall

Multiple [System.IO.File]::ReadAllText($relativePath) calls failed with
"Could not find a part of the path 'C:\Users\pc\src\core\...'" because
.NET's current working directory in PowerShell does not always follow the
PowerShell $PWD after Set-Location / cd. The relative path .\src\... resolved
against C:\Users\pc rather than C:\Users\pc\NEXUS.

What was done: subsequent file edits use absolute paths
(C:\Users\pc\NEXUS\src\core\...) with [System.IO.File] methods, which removes
the ambiguity.

Files affected: none. The failed calls returned $null before WriteAllText
was invoked, so no partial writes occurred.

## Incident 2 — PowerShell session terminations

Two PowerShell sessions terminated mid-command during the kernel
await initializeAsync() edit. Set-Content is not atomic across process
death.

What was done: after each termination, the file state was verified with
git diff --stat, Select-String, and npx tsc --noEmit -p . before any further
edit. On both occasions, tsc confirmed the tree was intact — the edit had not
been partially applied. No corruption occurred.

Files affected: none.

## Incident 3 — accidental em-dash edit

A PowerShell replacement that expected a doubled method declaration was run;
it did not throw despite the doubled declaration not existing in the file.
The observed diff was a single character change in a comment on line 4841:
an em-dash was replaced by three spaces.

What was done: git checkout -- src\core\execution-store.ts reverted the
change. The comment was restored; no other line changed. A follow-up cosmetic
commit 9153d5c ("chore(phase300): fix execution-store comment encoding")
recorded the reversion.

Files affected: execution-store.ts line 4841, comment only (reverted).

## Incident 4 — commit message shell-escape failure

The first attempt to commit WP3 v2 with a multi-line message containing
escaped quotes failed with "error: unknown switch '>'" because PowerShell
and git disagreed about how the argument was parsed. The commit did not
happen; the files remained staged.

What was done: the commit message was written to
C:\Users\pc\NEXUS\.git\PHASE300_WP3_COMMIT_MSG.txt via a single-quoted
here-string (@'...'@) and committed with git commit -F <file>. Commit
977ed86 landed successfully.

Files affected: none. The failed commit was not partially applied.

## Incident 5 — artifacts directory creation misread

An earlier PowerShell block printed "artifacts/phase300/ created." and ran
Get-ChildItem against the (nonexistent) directory. Because Get-ChildItem
returns no output for a missing directory, the absence was not immediately
visible. The subsequent git add artifacts/phase300/ failed with
"pathspec 'artifacts/phase300/' did not match any files". No artifacts were
committed at that time.

What was done: re-created the directory explicitly with New-Item -ItemType
Directory -Force, then created each file with Out-File -FilePath. Verified
each file's presence and non-zero size with Get-ChildItem before proceeding
to the next block.

Files affected: none. The failure was in the diagnostic print, not in state.

## Incident 6 — BOM in commit subject

Out-File -Encoding utf8 on Windows PowerShell 5 emits a UTF-8 BOM at the
start of the file. That BOM is now the first byte of commit 977ed86's
subject line. Cosmetic only.

What was done: nothing. Amending a committed hash for a cosmetic issue is
not appropriate. Documented here so the record is honest.
