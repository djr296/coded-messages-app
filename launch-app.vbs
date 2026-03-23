Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

nodeDir = shell.ExpandEnvironmentStrings("%LOCALAPPDATA%") & "\Programs\nodejs-portable\node-v20.20.1-win-x64"
appDir = fso.GetParentFolderName(WScript.ScriptFullName)

shell.CurrentDirectory = appDir
shell.Run """" & nodeDir & "\npm.cmd"" start", 0, False
