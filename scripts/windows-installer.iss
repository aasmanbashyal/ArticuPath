[Setup]
AppId={{C83E5BEB-7A66-49E2-972D-C0863D40CB94}
AppName=Rehearsal
AppVersion={#RehearsalVersion}
VersionInfoVersion={#RehearsalVersion}.0
AppPublisher=Rehearsal
AppPublisherURL=https://github.com/aasmanbashyal/rehearsal
DefaultDirName={localappdata}\Programs\Rehearsal
DefaultGroupName=Rehearsal
UsePreviousGroup=no
PrivilegesRequired=lowest
ArchitecturesAllowed=x64os
ArchitecturesInstallIn64BitMode=x64os
MinVersion=10.0.22000
OutputBaseFilename=Rehearsal-Setup-windows-x64
SetupIconFile=..\public\assets\rehearse.ico
UninstallDisplayIcon={app}\Rehearsal.exe
WizardStyle=modern
Compression=lzma2
SolidCompression=yes

[Files]
Source: "{#PayloadDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[InstallDelete]
Type: files; Name: "{app}\ArticuPath.exe"
Type: files; Name: "{userprograms}\ArticuPath\ArticuPath.lnk"
Type: dirifempty; Name: "{userprograms}\ArticuPath"

[Icons]
Name: "{group}\Rehearsal"; Filename: "{app}\Rehearsal.exe"; WorkingDir: "{app}"

[Run]
Filename: "{app}\Rehearsal.exe"; Description: "Open Rehearsal"; Flags: postinstall nowait skipifsilent
