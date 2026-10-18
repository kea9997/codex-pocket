# Codex Pocket · 설치와 사용

Windows PC에서 열린 기존 Codex 대화를 같은 Tailscale의 Android 휴대폰에서 이어 쓰는 **전체 소스 앱**입니다. OpenAI 공식 제품이 아니며 원본 코드는 MIT입니다. 영문 [README](README.md), [보안](SECURITY.md), [검증](VALIDATION.md)을 함께 확인해 주세요. UI는 한국어입니다.

## 준비

- Windows11의 같은 로그인 사용자로 stock Codex 데스크톱을 열어 둡니다. Node22+, PowerShell7+, 이미 연결된 PC/휴대폰 Tailscale이 필요합니다.
- Android8/API26+와 최신 WebView를 사용합니다. APK 빌드는 JDK17, SDK platform36/build-tools36.0.0이 필요합니다. 실제 기기/접힘/키보드/서명 설치는 별도 검증해야 합니다.
- 읽기 전용 Codex 실행 파일은 stock 사용자 설치 경로의 유일한 안전한 후보만 지원합니다. custom 경로·모호한 설치·다른 계정/provider로 자동 전환하지 않습니다.
- 계정 저장/전환은 지원되는 file 저장 로그인만 가능하며 keyring·관리 정책·custom home·미지원 저장 방식은 거절합니다. 전역 저장 정책을 자동 변경하지 않습니다.

## 설치 순서

일반 사용자 PowerShell7에서 소스 폴더로 이동합니다. checkout 경로에는 공백이 있어도 됩니다. 개인 상태는 소스 밖의 `$env:USERPROFILE/.codex-pocket` 같은 일반 디렉터리를 사용하고 MSIX 가상화 AppData는 피합니다. 관리자/ExecutionPolicy 우회·방화벽·Tailscale 자동 변경은 없습니다.

README의 예시100.64.0.10/.11은 가상 값입니다. 실제 PC tailnet IPv4, 정확히 허용할 휴대폰 IPv4, 전용 Codex controller 대화 UUID를 본인 값으로 지정하세요. controller는 PC에서 사람이 준비한 실제 대화여야 하며 서버는 임의로 만들거나 추정하지 않습니다.

```powershell
$pc = Read-Host 'PC Tailscale IPv4'
$phone = Read-Host '휴대폰 Tailscale IPv4'
$controller = Read-Host '전용 controller 대화 UUID'
$private = Join-Path $env:USERPROFILE '.codex-pocket'
.\scripts\Setup-Bridge.ps1 -HostIPv4 $pc -PhonePeers @($phone) -ControllerThreadId $controller -PrivateDirectory $private -WhatIf
# 내용을 확인한 다음 동일 명령에서 -WhatIf를 빼서 설정합니다.
```

host/peer는100.64.0.0/10의 구체 IPv4만 허용하며 wildcard/LAN/public/dynamicDNS는 지원하지 않습니다. 포트 기본47831,1024–65535,peer1–16개,중복/host동일 값은 거절합니다. 설정은 CurrentUser 전용 보호 ACL의 새 파일만 만들며 기존 bridge.json을 덮어쓰지 않습니다. 최초 private 폴더는 새 폴더/빈 폴더여야 하고 `.pocket-private`로 전용 상태를 표시합니다. 기존 내용이 있는 미표시 폴더나 드라이브/사용자 홈 루트는 가져오거나 재사용하지 않습니다. 기본 주소로 자동 시작하지 않습니다.

```powershell
.\scripts\Start-Bridge.ps1 -Foreground -PrivateDirectory $private
# 다른 PowerShell7 창에서 연결 코드 발급 요청:
.\scripts\Request-Pairing.ps1 -PrivateDirectory $private
```

private pairing.json의 코드를 **로컬에서만** 확인해 앱에 입력합니다. 코드16자리/24시간/한 번 사용, 연결7일입니다. 로그·메신저·이슈에 코드를 붙이지 마세요. PC 브라우저는 별도 pairing이 필요할 수 있으며 `Open-Accounts.ps1`로 동일 계정 패널을 열 수 있습니다. Codex 계정 전환과 휴대폰 연결은 별개입니다.

## Android 빌드

Windows에서는 **소스·JDK·SDK·개인 빌드 폴더 경로를 영문/숫자 등 ASCII 문자로 지정**하세요. 공백 경로는 검증했으나 한글 경로에서는 Android 도구가 실제 폴더를 열지 못했습니다. Windows 사용자 이름이 한글이면 계정 이름을 변경하지 말고, 소스/AppData 밖의 새 전용 폴더(예: `D:/CodexPocketPrivate`)를 만들도록 `-PrivateDirectory`를 명시하세요. 기존 자료가 들어 있는 폴더를 재사용하지 마세요. 한글을 포함한 Android 빌드 경로는 지원하지 않습니다.

`JAVA_HOME`/`ANDROID_SDK_ROOT` 또는 명시적 `-JdkPath`/`-SdkPath`를 설정합니다.

```powershell
.\scripts\Build-Android.ps1 -HostIPv4 $pc -PrivateDirectory $private -Unsigned
.\scripts\Build-Android.ps1 -HostIPv4 $pc -PrivateDirectory $private
```

각 빌드는 새 private GUID 폴더만 사용하며 소스 파일을 바꾸지 않습니다. 정확한 origin/port와 Android cleartext 허용 host를 함께 생성합니다. 범용 APK가 아니라 본인의 주소와 본인의 서명으로 빌드합니다. 공개 package는 `dev.codexpocket.app`, 이름 Codex Pocket,0.3.0/versionCode4입니다. 서명키/비밀번호는 private 폴더에 새로 만들고 공유하지 않습니다. 향후 업데이트를 위해 본인이 안전하게 백업해야 합니다. 키 분실 시 기존 앱 제거가 필요할 수 있습니다. 빌드는 서명/정렬/SHA256을 확인하지만 설치·전달은 하지 않습니다. 검토한 signed APK만 본인이 수동 설치하세요.

## 사용·복구

- 질문은 native 답변 또는 같은 sourceKey의 전달 확인이 있는 항목을 제외하고 **미응답만** 보여 줍니다. 선택지/직접 입력은 바로 사용할 수 있으나 보내기를 직접 눌러야 전송됩니다. 과거 작업의 async 질문도 미응답이면 남으며 현재 PC 대기라고 추정하지 않습니다.
- 전달 확인은 native 질문 폼 완료나 PC 승인이 아닙니다. reserved/uncertain/acknowledged는 완료로 숨기지 않습니다. 소스 실패/부분 조회 시 입력·복구를 보존합니다. PC 답변이 도착하면 오래된 질문 폼만 제외하고 일반 초안은 바꾸지 않습니다.
- 보내기와 새 대화는 명시적 행동만 수행하고 자동 재전송하지 않습니다. 불명 전송은 실제 기록을 확인한 뒤 안내된 잠금 해제 절차를 따르세요. 해제는 전달 성공이나 취소가 아닙니다. 첨부는 UUID/hash에 묶이며 임의 재업로드/재전송하지 않습니다.
- 모델/노력 기본값은 PC 설정 유지입니다. 현재 PC 설정을 읽었다고 추정하지 않습니다. 공개 앱은 개발자의 별도 workflow 지침을 프롬프트에 삽입하지 않습니다. 승인·중지는 PC에서 처리합니다.
- 한도·크레딧·초기화 횟수·계정 토큰 활동은 서로 다른 값입니다. 상세에서 누적+최신 제공 날짜 값을 보여 주며 오늘/UTC나 비용으로 추정하지 않습니다. 초기화 예정 경과는 실제 복구가 아니며 환율 환산도 참고값입니다. 원래 정밀 소수/환산 근거는 접힌 설명에서 볼 수 있고 오래됨/환율 실패는 계속 보입니다.
- 계정 추가는 공식 device-code 사이트에서 최초 사람이 로그인해야 합니다. 토큰은 PC의 CurrentUser DPAPI/ACL로 보호하고 웹으로 전달하지 않습니다. 작업 유휴/입력·첨부·불명 요청을 확인한 뒤 명시적으로 전환합니다. 임의 프로세스 강제 종료·경쟁 로그인 덮어쓰기·미지원 hot switch는 없습니다. 복구 journal을 지워 해결하려 하지 마세요.
- 화면 밖 알림은 직접 켜는 foreground 알림입니다. 절전/Tailscale/강제 종료로 늦을 수 있습니다. 파일 선택은 읽기 전용 임시 권한, 저장/공유는 명시적 SAF/share만 사용합니다.

중지는 `Stop-Bridge.ps1 -PrivateDirectory $private`, 선택적 시작 작업은 `Install-LoginTask.ps1 ... -WhatIf` 확인 뒤 직접 등록합니다. task는 CodexPocket-Bridge이며 기존 task는 덮어쓰지 않고 등록만으로 실행하지 않습니다. 제거는 이 앱만 중지한 뒤 자신이 설치한 task만 Windows에서 제거하세요. 개인 데이터/서명키는 자동 삭제하지 않습니다.

기본 합성 검사 `node --test tests/*.test.mjs tools/public-preview/demo.test.mjs`, 소스 검사 `node tools/source-package.mjs`를 실행합니다. Windows 합성 helper6개는 별도 opt-in이며 검토 없이 실행하지 마세요. Node 성공은 실기기/빌드/실계정 성공이 아닙니다. 독립 UI 데모는 실제 서버/계정에 연결하지 않는 보조 수단입니다. 공개 전 전체 source/hash/privacy/license와 VALIDATION.md의 실제 설치 검증이 필요합니다.
