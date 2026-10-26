# GPUiX 페어링 유틸리티 — 리뷰용 단계

데몬에 붙어 있는 페어링 유틸리티의 별도 실행 경로다. 터미널/도킹 워크벤치는 포함하지 않는다. 기존 `web/desktop/main.ts`, CEF 설정, MSI/PKG 런처 및 기본 실행 경로는 변경하지 않았다. 기본 전환이나 설치는 하지 않는다.

## 구조

- `src/host.ts`: Node의 `node:net`으로 기존 프로필별 GUI named pipe를 소유하고 요청 상태를 관리한다. GPU 창을 만들기 전에 기존 인스턴스를 활성화한다.
- `src/controller.ts`: 네 라우트, 네 바인딩과 snapshot 상태. 교체, 창 닫기, 연결 해제, 종료 시 보류된 확인을 거절한다. 이전 화면의 클릭은 세대 검사로 새 요청에 적용되지 않는다.
- `src/main.tsx`, `src/view.tsx`: Bun에서 출시된 `@gpuix/solid`와 `@gpuix/native` **각각 정확히 0.11.0**을 사용한다. QR, 만료 시간, 네 후보 코드와 잘못된 코드 거절, daemon 정보/설정 열기를 표시한다.
- `native/windows.rs`: 기존 Rieul 자체 close guard를 재사용하는 작은 DLL. PID로 이 프로세스의 GPU 창을 찾아 `WM_CLOSE`를 숨김으로 바꾸고 숨김/재표시를 제공한다. GPUI/GPUiX 소스 패치는 없다.
- `src/windows-tray.ts`, `src/win-ffi.ts`: 기존 Rieul Windows 트레이 구현을 Bun FFI로 이식했다. 트레이 활성화, daemon info, Quit, balloon과 실패 시 창 표시 fallback을 유지한다.
- `src/platform.ts`, `native/macos.m`, `src/macos.ts`: 공통 플랫폼 계약과 AppKit delegate/status-item 브리지 소스다. macOS 소스는 아직 빌드/실행 검증되지 않았고 Windows entry 또는 macOS 기본 경로에서 선택되지 않는다.

Node와 Bun 사이에는 부모/자식 전용 IPC 채널을 사용한다. Bun 1.3.9의 Windows `node:net` 반닫기 응답 문제가 fixture에서 재현되어 daemon IPC는 Node에 유지했다. 외부 CBOR IPC와 proc id는 기존 `web/src/protocol/socket-ipc.ts`를 직접 재사용한다. HTTP mutation 서버는 필요하지 않다. `getSnapshot`의 `desktopApiUrl` 필드는 빈 문자열이며, snapshot 이벤트 이름은 `rieul-daemon-snapshot`이다. native UI의 이벤트 대상은 `globalThis.rieulDesktopEvents`, 네 바인딩은 `globalThis.bindings`다.

설정 경로를 realpath로 안정화하고 Windows verbatim 접두사를 제거한 뒤 기존과 같은 SHA-256 앞 12바이트로 profile ID를 만든다. CEF와도 동일한 `\\.\pipe\rieul-gui-profile-<id>`를 사용한다. 전역 앱 잠금은 없다. macOS 소켓 경로 생성 계약은 유지하지만 새 macOS shell은 아직 실행하지 않는다.

## 로컬 실행

Node 24.13 이상, Bun 1.3.9 이상과 Windows MSVC Rust 도구가 필요하다. 전역 Rust 기본 버전은 바꾸지 않는다.

```powershell
cd pairing
bun install --frozen-lockfile
./scripts/build-bridge.ps1 -Rustc <설치된-rustc.exe>
bun run check
bun run test
bun run build
```

실제 데몬 없이 사용할 별도 설정을 만든다. 아래 경로는 기존 설치 설정과 분리되어 있다.

```powershell
New-Item -ItemType Directory -Force ../tmp/pairing-review | Out-Null
Set-Content ../tmp/pairing-review/rieul.yaml 'listenAddr: 127.0.0.1:19019'
./scripts/launch.ps1 -Config ../tmp/pairing-review/rieul.yaml -Node <node.exe> -Bun <bun.exe> -Show
```

직접 소스 실행은 `RIEUL_PAIRING_BUN=<bun.exe>`를 지정한 뒤 `node src/host.ts --config <config> --show`다. `bun src/main.tsx`는 부모 IPC가 없어 거부된다. 해당 프로필의 CEF가 이미 실행 중이면 새 GUI를 띄우지 않고 기존 GUI를 활성화한다.

## 자동 검증과 독립 스테이징

```powershell
$env:RIEUL_PAIRING_BUN = '<bun.exe>'
node scripts/native-qa.mjs
./scripts/stage.ps1 -Bun <bun.exe> -OutDir <새-디렉터리>
```

스테이징은 Node 호스트/컴파일된 Solid UI, DLL, 아이콘, 고정 production 의존성과 명시적 `launch.ps1`만 새 디렉터리에 만든다. Node와 Bun 런타임은 별도로 필요하다. MSI를 생성하거나 서비스·autostart를 등록하지 않는다. 기존 디렉터리는 덮어쓰지 않는다.

빌드/스테이징 결과에 같은 QA를 실행하려면 `RIEUL_PAIRING_HOST`를 그 `dist/host.js` 절대 경로로 지정한다. QA는 실행마다 `artifacts/qa-<timestamp>/rieul.yaml`과 가짜 CBOR 요청을 사용한다. 실제 서비스, 자격증명, 장치 승인에는 연결하지 않는다. 성공 확인 클릭도 이 가짜 요청에만 적용한다. native automation은 자식 프로세스의 `RIEUL_PAIRING_AUTOMATION=1` 명시 설정에서만 열린다.

자세한 검증 결과와 한계는 [VERIFICATION.md](./VERIFICATION.md)에 기록했다.

## 기본 전환 전에 남은 범위

macOS는 기존 CEF를 사용한다. 추가한 AppKit 소스는 원래 GPUI delegate로 기타 메시지를 전달하면서 close를 가로채 orderOut하고, NSStatusItem 활성화/메뉴/정리를 제공한다. C ABI의 이벤트 비트를 JS가 poll하므로 AppKit에서 JS callback을 직접 호출하지 않는다. 알림은 새 권한을 요청하지 않고 창 표시로 fallback한다. `sh scripts/build-bridge-macos.sh`는 macOS에서만 Cocoa dylib를 빌드하며 호스트의 Windows 제한을 해제하지 않는다. AppKit 메인 스레드/실제 delegate 수명/숨김 후 재표시/종료와 서명·PKG 실행은 macOS에서 별도 검증해야 한다. 이 소스의 컴파일 성공도 Windows에서 주장하지 않는다. 선택하지 않은 다른 shell이나 GPL 코드 복사는 사용하지 않았다.

Windows의 트레이 popup을 사람처럼 직접 선택하는 검증, Explorer 재시작 후 아이콘 복구, 알림이 실제로 화면에 나타나는지, 기본 연결 앱으로 설정 파일을 여는 end-to-end 검증은 남아 있다. Quit 명령에 따른 실제 프로세스 정리와 native balloon 호출/실패 fallback 상태 처리는 별도로 검증했다. 이 한계가 해소되기 전 CEF 제거 및 기본 패키징 전환은 하지 않는다.
