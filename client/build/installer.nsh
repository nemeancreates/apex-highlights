; ================================
; Peak-Abu NSIS customization
; Cleans up everything the app leaves behind EXCEPT the user's saved
; highlight videos and their .json sidecars.
; ================================

!macro customInstall
  ; Re-register the deep-link protocol on every install, including silent
  ; updates (a silent /S update otherwise skips protocol registration).
  WriteRegStr HKCU "Software\Classes\peakabu" "" "URL:Peak-Abu Session"
  WriteRegStr HKCU "Software\Classes\peakabu" "URL Protocol" ""
  WriteRegStr HKCU "Software\Classes\peakabu\shell" "" ""
  WriteRegStr HKCU "Software\Classes\peakabu\shell\open" "" ""
  WriteRegStr HKCU "Software\Classes\peakabu\shell\open\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "%1"'
!macroend

!macro customUnInstall
  ; During a silent auto-update, electron-builder runs the OLD uninstaller
  ; first. ${isUpdated} is TRUE in that case and FALSE on a genuine,
  ; user-initiated uninstall. Guard all app-data cleanup behind it so
  ; preferences / localStorage / caches survive updates and are removed
  ; ONLY when the user actually uninstalls.
  ${ifNot} ${isUpdated}
    ; --- Rolling buffer (default location, when no custom storage dir was set)
    RMDir /r "$TEMP\apex-highlights-buffer"

    ; --- FFmpeg debug log
    Delete "$TEMP\peakabu-ffmpeg.log"

    ; --- App data: preferences, Electron caches, GPU cache, local storage
    RMDir /r "$APPDATA\Peak-Abu"
    RMDir /r "$APPDATA\peak-abu"
    RMDir /r "$LOCALAPPDATA\Peak-Abu"
    RMDir /r "$LOCALAPPDATA\peak-abu"

    ; --- Deep-link protocol registration
    DeleteRegKey HKCU "Software\Classes\peakabu"
    DeleteRegKey /ifempty HKCR "peakabu"
  ${endIf}

  ; --- Leftover update installers: safe to clear on both paths
  Delete "$TEMP\PeakAbu-Update-*.exe"

  ; NOTE: user highlight videos and their .json sidecars are intentionally
  ; NOT touched. They live in the user's chosen storage directory.
!macroend