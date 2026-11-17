[Setup]
AppId={{C83E5BEB-7A66-49E2-972D-C0863D40CB94}
AppName=ArticuPath
AppVersion={#ArticuPathVersion}
AppPublisher=ArticuPath
AppPublisherURL=https://github.com/aasmanbashyal/ArticuPath
DefaultDirName={localappdata}\Programs\ArticuPath
DefaultGroupName=ArticuPath
PrivilegesRequired=lowest
ArchitecturesAllowed=x64os
ArchitecturesInstallIn64BitMode=x64os
MinVersion=10.0.22000
OutputBaseFilename=ArticuPath-Setup-windows-x64
SetupIconFile=..\public\assets\rehearse.ico
UninstallDisplayIcon={app}\ArticuPath.exe
WizardStyle=modern
Compression=lzma2
SolidCompression=yes

[Files]
Source: "{#PayloadDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\ArticuPath"; Filename: "{app}\ArticuPath.exe"; WorkingDir: "{app}"

[Run]
Filename: "{app}\ArticuPath.exe"; Description: "Open ArticuPath"; Flags: postinstall nowait skipifsilent
