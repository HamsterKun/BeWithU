!macro customUnInstall
  ${ifNot} ${isUpdated}
    SetShellVarContext current
    Delete "$SMSTARTUP\BeWithU - Startup.lnk"
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "com.bewithu.app"
    ${if} $installMode == "all"
      SetShellVarContext all
    ${endIf}
  ${endIf}
!macroend
