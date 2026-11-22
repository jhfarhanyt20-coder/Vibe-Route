' Starts Vibe Proxy in the background with no console window.
' Double-click this file, or put a shortcut in shell:startup to run it at login.
Dim fso, shell, here
Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")
here = fso.GetParentFolderName(WScript.ScriptFullName)
shell.CurrentDirectory = here
shell.Run "cmd /c ""node"" ""proxy.cjs""", 0, False
