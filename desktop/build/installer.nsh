!include FileFunc.nsh
!include LogicLib.nsh

; The installer runs the previous uninstaller first, so replace it before that step
; to make upgrades from versions without this macro preserve runtime as well.
!macro customInstallmode
  ${if} ${isUpdated}
    ${if} $installMode == "all"
      StrCpy $isForceMachineInstall "1"
    ${else}
      StrCpy $isForceCurrentInstall "1"
    ${endif}
  ${endif}
!macroend

!ifndef BUILD_UNINSTALLER
!macro customFinishPage
  Function openficUpdateFinishPagePre
    ${if} ${isUpdated}
      HideWindow
      ${StdUtils.ExecShellAsUser} $0 "$launchLink" "open" "--updated"
      Abort
    ${endif}
  FunctionEnd

  !ifndef HIDE_RUN_AFTER_FINISH
    Function openficStartApp
      ${if} ${isUpdated}
        StrCpy $1 "--updated"
      ${else}
        StrCpy $1 ""
      ${endif}
      ${StdUtils.ExecShellAsUser} $0 "$launchLink" "open" "$1"
    FunctionEnd

    !define MUI_FINISHPAGE_RUN
    !define MUI_FINISHPAGE_RUN_FUNCTION "openficStartApp"
  !endif

  !define MUI_PAGE_CUSTOMFUNCTION_PRE openficUpdateFinishPagePre
  !insertmacro MUI_PAGE_FINISH
!macroend
!endif

; Pinned-template compatibility: this hook targets app-builder-lib 26.15.6 (electron-builder 26.15.6
; is pinned in desktop/package.json). installer.nsi inserts customHeader before Function .onInit and
; before Section "install", so the hidden preflight section below is compiled before installSection.nsh
; calls uninstallOldVersion. Retention trigger: remove this seam if upstream app-builder-lib exposes a
; before-uninstall extension point that can prepare the previously registered uninstaller directly.
!ifndef BUILD_UNINSTALLER
!macro customHeader
; Replace the uninstaller registered for one hive so the framework can still run it after the install
; tree is replaced. An absent registration is a fresh-install no-op; a registered but unusable entry
; is fail-closed. GetInQuotes is declared later in installUtil.nsh but forwards fine at compile time.
Function openficPreparePriorUninstaller
  Exch $R0
  Push $R1

  StrCmp $R0 "SHELL_CONTEXT" 0 openfic_prepare_hkcu
    ReadRegStr $R1 SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY}" UninstallString
    StrCmp $R1 "" 0 openfic_prepare_read
    !ifdef UNINSTALL_REGISTRY_KEY_2
      ReadRegStr $R1 SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY_2}" UninstallString
    !endif
    Goto openfic_prepare_read
  openfic_prepare_hkcu:
    ReadRegStr $R1 HKEY_CURRENT_USER "${UNINSTALL_REGISTRY_KEY}" UninstallString
    StrCmp $R1 "" 0 openfic_prepare_read
    !ifdef UNINSTALL_REGISTRY_KEY_2
      ReadRegStr $R1 HKEY_CURRENT_USER "${UNINSTALL_REGISTRY_KEY_2}" UninstallString
    !endif
  openfic_prepare_read:

  StrCmp $R1 "" openfic_prepare_return
  Push $R1
  Call GetInQuotes
  Pop $R1
  StrCmp $R1 "" 0 openfic_prepare_copy
    SetErrorLevel 2
    MessageBox MB_ICONSTOP|MB_TOPMOST "OpenFix cannot prepare the previous uninstaller to protect the runtime directory." /SD IDOK
    Abort
  openfic_prepare_copy:

  ; CopyFiles creates a missing destination, so the registered old executable must be proven to be
  ; an existing file first: replacing nothing would silently defeat the runtime-preserving upgrade.
  IfFileExists "$R1" 0 openfic_prepare_unusable
  IfFileExists "$R1\*.*" openfic_prepare_unusable

  ClearErrors
  CopyFiles /SILENT "$PLUGINSDIR\openfic-prior-uninstaller.exe" "$R1"
  IfErrors 0 openfic_prepare_return

  openfic_prepare_unusable:
  SetErrorLevel 2
  MessageBox MB_ICONSTOP|MB_TOPMOST "OpenFix cannot prepare the previous uninstaller to protect the runtime directory." /SD IDOK
  Abort

  openfic_prepare_return:
  Pop $R1
  Pop $R0
FunctionEnd

; Hidden preflight section (empty name): it runs before Section "install". It first mirrors the
; framework's guarded silent per-machine elevation, then prepares the same hives as installSection.nsh
; (SHELL_CONTEXT, and HKEY_CURRENT_USER only when the final mode is all-users), so both preparations
; finish before either framework uninstallOldVersion call.
Section ""
  !ifndef INSTALL_MODE_PER_ALL_USERS
    !ifndef ONE_CLICK
      ${if} $hasPerMachineInstallation == "1"
      ${andIf} ${Silent}
        ${ifNot} ${UAC_IsAdmin}
          ShowWindow $HWNDPARENT ${SW_HIDE}
          !insertmacro UAC_RunElevated
          ${Switch} $0
            ${Case} 0
              ${Break}
            ${Case} 1223
              ${Break}
            ${Default}
              MessageBox mb_IconStop|mb_TopMost|mb_SetForeground "Unable to elevate, error $0"
              ${Break}
          ${EndSwitch}
          Quit
        ${else}
          !insertmacro setInstallModePerAllUsers
        ${endIf}
      ${endIf}
    !endif
  !endif

  InitPluginsDir
  File /oname=$PLUGINSDIR\openfic-prior-uninstaller.exe "${UNINSTALLER_OUT_FILE}"

  Push "SHELL_CONTEXT"
  Call openficPreparePriorUninstaller

  ${if} $installMode == "all"
    Push "HKEY_CURRENT_USER"
    Call openficPreparePriorUninstaller
  ${endif}
SectionEnd
!macroend
!endif

!ifdef BUILD_UNINSTALLER
Var openficPreserveRuntime

Function un.openficAtomicRemove
  Exch $R0
  Push $R1
  Push $R2
  Push $R3
  Push $R4

  StrCpy $R3 "$INSTDIR$R0\*.*"
  ClearErrors
  FindFirst $R1 $R2 $R3
  IfErrors openfic_atomic_remove_error_no_close

  openfic_atomic_remove_loop:
    StrCmp $R2 "" openfic_atomic_remove_success
    StrCmp $R2 "." openfic_atomic_remove_next
    StrCmp $R2 ".." openfic_atomic_remove_next
    ${if} $openficPreserveRuntime == "1"
      ${if} $R0 == ""
        StrCmp $R2 "runtime" openfic_atomic_remove_next
      ${endif}
    ${endif}

    ClearErrors
    ${GetFileAttributes} "$INSTDIR$R0\$R2" "REPARSE_POINT" $R4
    IfErrors openfic_atomic_remove_error
    ${if} $R4 == "1"
      StrCpy $R3 "$INSTDIR$R0\$R2"
      Goto openfic_atomic_remove_error
    ${endif}

    IfFileExists "$INSTDIR$R0\$R2\*.*" openfic_atomic_remove_directory openfic_atomic_remove_file

  openfic_atomic_remove_directory:
    CreateDirectory "$PLUGINSDIR\old-install$R0\$R2"
    Push "$R0\$R2"
    Call un.openficAtomicRemove
    Pop $R3
    ${if} $R3 != 0
      Goto openfic_atomic_remove_done
    ${endif}
    Goto openfic_atomic_remove_next

  openfic_atomic_remove_file:
    ClearErrors
    Rename "$INSTDIR$R0\$R2" "$PLUGINSDIR\old-install$R0\$R2"
    StrCmp "$R0\$R2" "\Uninstall ${PRODUCT_FILENAME}.exe" 0 +2
      ClearErrors
    IfErrors 0 +3
      StrCpy $R3 "$INSTDIR$R0\$R2"
      Goto openfic_atomic_remove_error

  openfic_atomic_remove_next:
    FindNext $R1 $R2
    Goto openfic_atomic_remove_loop

  openfic_atomic_remove_success:
    StrCpy $R3 0
    Goto openfic_atomic_remove_done

  openfic_atomic_remove_error:
    FindClose $R1
    Goto openfic_atomic_remove_return

  openfic_atomic_remove_error_no_close:
    StrCpy $R3 "$INSTDIR$R0"
    Goto openfic_atomic_remove_return

  openfic_atomic_remove_done:
    FindClose $R1

  openfic_atomic_remove_return:
    StrCpy $R0 $R3
    Pop $R4
    Pop $R3
    Pop $R2
    Pop $R1
    Exch $R0
FunctionEnd

Function un.openficRemoveDirect
  Exch $R0
  Push $R1
  Push $R2
  Push $R3
  Push $R4

  ClearErrors
  ${GetFileAttributes} "$INSTDIR$R0" "REPARSE_POINT" $R4
  IfErrors openfic_direct_success
  ${if} $R4 == "1"
    ${GetFileAttributes} "$INSTDIR$R0" "DIRECTORY" $R4
    IfErrors openfic_direct_error_no_close
    ${if} $R4 == "1"
      ClearErrors
      RMDir "$INSTDIR$R0"
    ${else}
      ClearErrors
      Delete "$INSTDIR$R0"
    ${endif}
    IfErrors openfic_direct_error_no_close
    Goto openfic_direct_success
  ${endif}

  ${GetFileAttributes} "$INSTDIR$R0" "DIRECTORY" $R4
  IfErrors openfic_direct_error_no_close
  ${if} $R4 != "1"
    ClearErrors
    Delete "$INSTDIR$R0"
    IfErrors openfic_direct_error_no_close
    Goto openfic_direct_success
  ${endif}

  StrCpy $R3 "$INSTDIR$R0\*.*"
  ClearErrors
  FindFirst $R1 $R2 $R3
  IfErrors openfic_direct_remove_empty

  openfic_direct_loop:
    StrCmp $R2 "" openfic_direct_done
    StrCmp $R2 "." openfic_direct_next
    StrCmp $R2 ".." openfic_direct_next

    Push "$R0\$R2"
    Call un.openficRemoveDirect
    Pop $R3
    ${if} $R3 != 0
      Goto openfic_direct_done
    ${endif}

  openfic_direct_next:
    ClearErrors
    FindNext $R1 $R2
    Goto openfic_direct_loop

  openfic_direct_done:
    FindClose $R1
    ${if} $R3 == 0
      ClearErrors
      RMDir "$INSTDIR$R0"
      IfErrors openfic_direct_error_no_close
    ${endif}
    Goto openfic_direct_return

  openfic_direct_remove_empty:
    ClearErrors
    RMDir "$INSTDIR$R0"
    IfErrors openfic_direct_error_no_close
    Goto openfic_direct_success

  openfic_direct_success:
    StrCpy $R3 0
    Goto openfic_direct_return

  openfic_direct_error_no_close:
    StrCpy $R3 "$INSTDIR$R0"
    Goto openfic_direct_return

  openfic_direct_return:
    StrCpy $R0 $R3
    Pop $R4
    Pop $R3
    Pop $R2
    Pop $R1
    Exch $R0
FunctionEnd
!endif

!macro customRemoveFiles
  SetOutPath $TEMP
  StrCpy $openficPreserveRuntime "1"
  CreateDirectory "$PLUGINSDIR\old-install"
  Push ""
  Call un.openficAtomicRemove
  Pop $R0
  ${if} $R0 != 0
    StrCpy $R4 $R0
    ${if} ${FileExists} "$PLUGINSDIR\old-install\*.*"
      Push ""
      Call un.restoreFiles
      Pop $R0
    ${endif}
    MessageBox MB_ICONSTOP "OpenFix cannot clean the installation directory while preserving runtime. Failed path: $R4"
    Abort
  ${endif}
  ${ifNot} ${isUpdated}
    Push "\runtime"
    Call un.openficRemoveDirect
    Pop $R0
    ${if} $R0 != 0
      StrCpy $R4 $R0
      ${if} ${FileExists} "$PLUGINSDIR\old-install\*.*"
        Push ""
        Call un.restoreFiles
        Pop $R0
      ${endif}
      MessageBox MB_ICONSTOP "OpenFix cannot remove the runtime during uninstall. Failed path: $R4"
      Abort
    ${endif}
    RMDir /r "$INSTDIR"
  ${endif}
!macroend
